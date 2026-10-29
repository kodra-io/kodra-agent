import { parse, parseAllDocuments, stringify } from 'yaml';
import type { Detection } from './detect.ts';
import type { SourceProvider } from './plan.ts';

/**
 * B1: the pipeline style. A repo either gets its own pipeline (standalone), or a thin caller
 * of the shared template the team's other repos use (a GitHub reusable workflow or a GitLab
 * `include: project`). Everything read here, the other repos' CI files and the template, is
 * untrusted data: it is parsed as YAML and never run, followed, or given to the model.
 */

export type PipelineMode = 'auto' | 'shared' | 'standalone';

/** One call of a shared template: a GitHub job's `uses`, or a GitLab `include: project` entry. */
export interface SharedUse {
  /** owner/repo or group/project that holds the template. */
  source: string;
  /** The workflow path (GitHub), or the included files (GitLab). */
  files: string[];
  ref: string | null;
  /** `with:` (GitHub) or `inputs:` (GitLab). */
  values: Record<string, string>;
  /** GitHub: the calling job's id, permissions, and secrets. */
  job?: string;
  permissions?: unknown;
  secrets?: 'inherit' | Record<string, string>;
}

/** What another repo's CI says about how it is built. */
export interface RepoCi {
  repo: string;
  /** The CI file the shared calls are in. */
  file: string | null;
  uses: SharedUse[];
  /** GitHub: the calling workflow's `name`, `on`, and `permissions`. */
  workflow?: { name?: string; on?: unknown; permissions?: unknown };
  /** GitLab: top-level `variables`, `stages`, and `workflow`. */
  variables?: Record<string, string>;
  stages?: unknown;
  gitlabWorkflow?: unknown;
}

export interface TemplateInput {
  name: string;
  required: boolean;
  description?: string;
  /** GitHub input type, for the value's YAML type. */
  type?: string;
}

/** What the shared template declares: inputs, and (GitHub) the secrets it requires. */
export interface TemplateSpec {
  inputs: TemplateInput[];
  /** GitHub required secrets, or GitLab variables the template reads but does not define. */
  needs: string[];
  /** Whether `inputs` came from a declaration (else nothing is known about them). */
  declared: boolean;
}

export type PipelineChoice =
  | { mode: 'standalone'; reason: string }
  | {
      mode: 'shared';
      reason: string;
      provider: SourceProvider;
      /** The file to write: the other repos' file name, or the provider's usual one. */
      path: string;
      content: string;
      template: string;
      /** Values to set before merging, with why: shown in the PR. */
      todo: { name: string; why: string }[];
    };

const SECRET_NAME =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)/i;

/** Parses `owner/repo/.github/workflows/x.yml@ref` or `group/project:file.yml[,file2.yml]@ref`. */
export function parseTemplateRef(provider: SourceProvider, text: string): SharedUse | null {
  const trimmed = text.trim();
  if (provider === 'github') {
    const m = /^([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[\w./-]+\.ya?ml)@([\w./-]+)$/.exec(
      trimmed,
    );
    return m?.[1] && m[2] && m[3] ? { source: m[1], files: [m[2]], ref: m[3], values: {} } : null;
  }
  const m = /^([\w.-]+(?:\/[\w.-]+)+):([\w./,-]+)@([\w./-]+)$/.exec(trimmed);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const files = m[2].split(',').filter(Boolean);
  return { source: m[1], files, ref: m[3], values: {} };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const scalar = (v: unknown): string | null =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

const stringValues = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(asRecord(v))) {
    // GitLab variables may be { value, description }.
    const value = scalar(raw) ?? scalar(asRecord(raw)['value']);
    if (value !== null) out[k] = value;
  }
  return out;
};

const safeParse = (text: string): unknown => {
  try {
    return parse(text) as unknown;
  } catch {
    return null;
  }
};

/** The shared calls in a repo's CI files (paths relative to the repo root). */
export function readRepoCi(
  provider: SourceProvider,
  repo: string,
  files: Readonly<Record<string, string>>,
): RepoCi {
  if (provider === 'github') {
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
      const doc = asRecord(safeParse(text));
      const uses: SharedUse[] = [];
      for (const [id, job] of Object.entries(asRecord(doc['jobs']))) {
        const j = asRecord(job);
        const ref = typeof j['uses'] === 'string' ? parseTemplateRef('github', j['uses']) : null;
        if (!ref) continue;
        const secrets = j['secrets'];
        uses.push({
          ...ref,
          values: stringValues(j['with']),
          job: id,
          ...(j['permissions'] !== undefined ? { permissions: j['permissions'] } : {}),
          ...(secrets === 'inherit'
            ? { secrets: 'inherit' as const }
            : secrets !== undefined
              ? { secrets: stringValues(secrets) }
              : {}),
        });
      }
      if (uses.length === 0) continue;
      const name = scalar(doc['name']);
      return {
        repo,
        file: path,
        uses,
        workflow: {
          ...(name !== null ? { name } : {}),
          ...(doc['on'] !== undefined ? { on: doc['on'] } : {}),
          ...(doc['permissions'] !== undefined ? { permissions: doc['permissions'] } : {}),
        },
      };
    }
    // CI of its own, with no shared call: it still counts as a repo with CI.
    const own = Object.keys(files)
      .sort()
      .find((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
    return { repo, file: own ?? null, uses: [] };
  }
  const text = files['.gitlab-ci.yml'];
  if (text === undefined) return { repo, file: null, uses: [] };
  const doc = asRecord(safeParse(text));
  const include = doc['include'];
  const entries = Array.isArray(include) ? include : include === undefined ? [] : [include];
  const uses: SharedUse[] = [];
  for (const entry of entries) {
    const e = asRecord(entry);
    const project = scalar(e['project']);
    if (!project) continue;
    const file = e['file'];
    const fileList = (Array.isArray(file) ? file : [file])
      .map(scalar)
      .filter((f): f is string => f !== null);
    uses.push({
      source: project,
      files: fileList,
      ref: scalar(e['ref']),
      values: stringValues(e['inputs']),
    });
  }
  return {
    repo,
    file: '.gitlab-ci.yml',
    uses,
    variables: stringValues(doc['variables']),
    ...(doc['stages'] !== undefined ? { stages: doc['stages'] } : {}),
    ...(doc['workflow'] !== undefined ? { gitlabWorkflow: doc['workflow'] } : {}),
  };
}

/** The inputs a template declares (GitHub `workflow_call`, GitLab `spec:inputs`). */
export function readTemplateSpec(provider: SourceProvider, text: string): TemplateSpec {
  if (provider === 'github') {
    const call = asRecord(asRecord(asRecord(safeParse(text))['on'])['workflow_call']);
    const inputs = Object.entries(asRecord(call['inputs'])).map(([name, raw]) => {
      const i = asRecord(raw);
      const description = scalar(i['description']);
      const type = scalar(i['type']);
      return {
        name,
        required: i['required'] === true && i['default'] === undefined,
        ...(description !== null ? { description } : {}),
        ...(type !== null ? { type } : {}),
      };
    });
    const needs = Object.entries(asRecord(call['secrets']))
      .filter(([, s]) => asRecord(s)['required'] === true)
      .map(([name]) => name);
    return { inputs, needs, declared: call['inputs'] !== undefined };
  }
  let docs: unknown[];
  try {
    docs = parseAllDocuments(text).map((d) => d.toJS() as unknown);
  } catch {
    return { inputs: [], needs: [], declared: false };
  }
  const header = asRecord(asRecord(docs[0])['spec']);
  if (docs.length > 1 && header['inputs'] !== undefined) {
    const inputs = Object.entries(asRecord(header['inputs'])).map(([name, raw]) => {
      const i = asRecord(raw);
      const description = scalar(i['description']);
      return {
        name,
        required: i['default'] === undefined,
        ...(description !== null ? { description } : {}),
      };
    });
    return { inputs, needs: [], declared: true };
  }
  // No declared inputs: the variables the template reads that GitLab or the file itself
  // does not set are what each project sets.
  const own = new Set<string>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(asRecord(d))) {
      if (k === 'variables') Object.keys(asRecord(v)).forEach((n) => own.add(n));
      Object.keys(asRecord(asRecord(v)['variables'])).forEach((n) => own.add(n));
    }
  }
  const read = new Set<string>();
  for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) {
    const name = m[1] ?? '';
    if (!/^(CI|GITLAB|DOCKER|FF|RUNNER|KUBERNETES|HOME|PATH)(_|$)/.test(name) && !own.has(name)) {
      read.add(name);
    }
  }
  return { inputs: [], needs: [...read].sort(), declared: false };
}

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A value the agent knows for a well-known input or variable name, from the detection. */
function known(key: string, d: Detection, o: { image: string; chartDir: string }): string | null {
  const k = norm(key);
  const java = d.java?.version;
  if (/^(image|imagename|imagerepository|imagerepo|dockerimage)$/.test(k)) return o.image;
  if (/^(chart|chartpath|chartdir|helmchart|helmchartpath)$/.test(k)) return o.chartDir;
  if (/^(javaversion|java|jdk|jdkversion)$/.test(k)) return java ? String(java) : null;
  if (/^(port|containerport|appport|serviceport)$/.test(k)) return String(d.port);
  if (/^(servicename|appname|app|service|name|projectname|applicationname)$/.test(k)) {
    return d.name;
  }
  if (/^(dockerfile|dockerfilepath)$/.test(k)) return 'Dockerfile';
  if (/^(context|buildcontext|dockercontext)$/.test(k)) return '.';
  if (/^(testcommand|testcmd|tests)$/.test(k)) return d.test ?? null;
  if (/^(healthpath|healthcheckpath|healthcheck)$/.test(k)) return d.healthPath;
  return null;
}

const repoName = (repo: string) => repo.split('/').filter(Boolean).at(-1) ?? repo;

/** A value from another repo, with that repo's own name replaced by this one's. */
function adapt(value: string, from: string, to: string): string {
  return value.split(from).join(to).split(repoName(from)).join(repoName(to));
}

/** A value copied from another repo: references only, never something that looks like a secret. */
function copyable(key: string, value: string, secretPatterns: readonly RegExp[]): boolean {
  const reference =
    /^\$\{\{\s*(secrets|vars|inputs|github)\.[\w.-]+\s*\}\}$|^\$\{?[A-Z][A-Z0-9_]*\}?$/;
  if (reference.test(value.trim())) return true;
  if (SECRET_NAME.test(key)) return false;
  return !secretPatterns.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(value));
}

const key = (u: SharedUse) => u.source.toLowerCase();
const shape = (uses: SharedUse[]) =>
  uses
    .map((u) => `${key(u)}:${u.files.join(',')}`)
    .sort()
    .join('|');

function mostCommon<T>(items: readonly T[], id: (t: T) => string): T | undefined {
  const counts = new Map<string, { item: T; n: number }>();
  for (const item of items) {
    const k = id(item);
    const c = counts.get(k);
    counts.set(k, { item: c?.item ?? item, n: (c?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.item;
}

export interface ChooseInput {
  provider: SourceProvider;
  /** owner/repo or group/project being shipped. */
  repo: string;
  defaultBranch: string;
  detection: Detection;
  image: string;
  chartDir: string;
  mode: PipelineMode;
  /** The configured template (`pipelineTemplate`), if any. */
  template: SharedUse | null;
  /** The other configured repos' CI. */
  others: readonly RepoCi[];
  /** The template's declaration, when it could be read. */
  spec: TemplateSpec | null;
  /** Credential patterns: a value matching one is never copied from another repo. */
  secretPatterns: readonly RegExp[];
}

/** Which shared template the other repos agree on, if any, and how many use it. */
export function sharedTemplate(
  others: readonly RepoCi[],
): { use: SharedUse; users: RepoCi[]; withCi: number } | null {
  const withCi = others.filter((o) => o.file !== null);
  const all = withCi.flatMap((o) => o.uses.map((u) => ({ u, o })));
  const top = mostCommon(all, ({ u }) => key(u));
  if (!top) return null;
  const users = withCi.filter((o) => o.uses.some((u) => key(u) === key(top.u)));
  // Most repos with CI, and at least two of them unless every one does.
  const agreed =
    (users.length >= 2 && users.length * 2 > withCi.length) || users.length === withCi.length;
  if (!agreed) return null;
  const ref = mostCommon(
    users.flatMap((o) => o.uses.filter((u) => key(u) === key(top.u))),
    (u) => u.ref ?? '',
  );
  return { use: { ...top.u, ref: ref?.ref ?? top.u.ref }, users, withCi: withCi.length };
}

/** Standalone, or a caller of the shared template, with every value it could work out. */
export function choosePipeline(i: ChooseInput): PipelineChoice {
  if (i.mode === 'standalone') {
    return { mode: 'standalone', reason: 'The connector is set to a standalone pipeline.' };
  }
  const agreed = sharedTemplate(i.others);
  const configured = i.template;
  if (!configured && !agreed) {
    const reason =
      i.others.length === 0
        ? 'No other repos are configured on this connector to learn a shared pipeline from.'
        : 'The other configured repos do not share a pipeline template.';
    return { mode: 'standalone', reason };
  }
  const sourceKey = (configured ?? agreed?.use)?.source.toLowerCase() ?? '';
  // Repos that call the chosen template, and the most common way they call it.
  const users = i.others.filter((o) => o.uses.some((u) => key(u) === sourceKey));
  const exemplar = mostCommon(users, (o) => shape(o.uses.filter((u) => key(u) === sourceKey)));
  const exemplarShape = exemplar ? shape(exemplar.uses.filter((u) => key(u) === sourceKey)) : '';
  const peers = users.filter(
    (o) => shape(o.uses.filter((u) => key(u) === sourceKey)) === exemplarShape,
  );
  const calls: SharedUse[] = configured
    ? [{ ...configured, ...(exemplar ? pickCallDetails(exemplar, configured) : {}) }]
    : (exemplar?.uses.filter((u) => key(u) === sourceKey) ?? []).map((u) => ({
        ...u,
        ref: agreed?.use.ref ?? u.ref,
      }));
  const template = `${calls[0]?.source ?? ''}${i.provider === 'github' ? '/' : ':'}${calls
    .flatMap((c) => c.files)
    .join(',')}@${calls[0]?.ref ?? ''}`;

  const todo: { name: string; why: string }[] = [];
  const resolve = (
    name: string,
    fromPeers: (o: RepoCi) => string | undefined,
    description?: string,
  ): string | null => {
    const mine = known(name, i.detection, i);
    if (mine !== null) return mine;
    const raw = peers.map(fromPeers).filter((v): v is string => v !== undefined);
    const agree = (values: string[]) =>
      values.length === peers.length && values.every((v) => v === values[0]);
    // The same value everywhere is shared as is; otherwise each repo's own name is swapped
    // for this one's, which works when the value is named after the repo.
    const seen = agree(raw)
      ? raw
      : peers.flatMap((o) => {
          const v = fromPeers(o);
          return v === undefined ? [] : [adapt(v, o.repo, i.repo)];
        });
    const first = seen[0];
    if (first !== undefined && agree(seen)) {
      if (copyable(name, first, i.secretPatterns)) return first;
      todo.push({
        name,
        why: 'looks like a credential, so it was not copied from the other repos',
      });
      return null;
    }
    todo.push({
      name,
      why:
        seen.length > 0
          ? 'differs between the other repos'
          : (description ?? 'the template needs it, and no other repo sets it'),
    });
    return null;
  };

  const declared = i.spec?.declared ? new Set(i.spec.inputs.map((x) => x.name)) : null;
  const callValues = (index: number): Record<string, string | null> => {
    const names = new Set<string>();
    for (const o of peers) {
      const peerCall = o.uses.filter((u) => key(u) === sourceKey)[index];
      Object.keys(peerCall?.values ?? {}).forEach((n) => names.add(n));
    }
    for (const input of i.spec?.inputs ?? []) {
      if (input.required || known(input.name, i.detection, i) !== null) names.add(input.name);
    }
    const out: Record<string, string | null> = {};
    for (const name of [...names].sort()) {
      // GitHub refuses inputs the workflow does not declare.
      if (declared && !declared.has(name)) continue;
      const description = i.spec?.inputs.find((x) => x.name === name)?.description;
      out[name] = resolve(
        name,
        (o) => o.uses.filter((u) => key(u) === sourceKey)[index]?.values[name],
        description,
      );
    }
    return out;
  };

  const agreement = agreed
    ? `${String(agreed.users.length)} of the ${String(agreed.withCi)} other repos with CI call ${template}`
    : '';
  const reason = configured
    ? `The connector names the shared pipeline ${template}.${agreement ? ` ${agreement}.` : ''}`
    : `${agreement}, so this repo calls it too.`;

  if (i.provider === 'github') {
    const call = calls[0];
    if (!call) return { mode: 'standalone', reason: 'No shared workflow to call.' };
    const values = callValues(0);
    const secretsNeeded = i.spec?.needs ?? [];
    const content = githubCaller({
      name: exemplar?.workflow?.name ?? 'CI',
      on: exemplar?.workflow?.on ?? {
        pull_request: null,
        push: { branches: [i.defaultBranch] },
      },
      permissions: exemplar?.workflow?.permissions ?? { contents: 'read' },
      job: call.job ?? 'pipeline',
      uses: `${call.source}/${call.files[0] ?? ''}@${call.ref ?? ''}`,
      jobPermissions: call.permissions,
      secrets: call.secrets ?? (secretsNeeded.length > 0 ? 'inherit' : undefined),
      values,
      types: Object.fromEntries((i.spec?.inputs ?? []).map((x) => [x.name, x.type ?? 'string'])),
      todo,
    });
    return {
      mode: 'shared',
      reason,
      provider: 'github',
      path: exemplar?.file ?? '.github/workflows/ci.yml',
      content,
      template,
      todo,
    };
  }

  // GitLab: the include entries, their inputs, and the top-level variables the others share.
  const includes = calls.map((c, index) => ({ call: c, inputs: callValues(index) }));
  const variableNames = new Set<string>();
  for (const o of peers) Object.keys(o.variables ?? {}).forEach((n) => variableNames.add(n));
  if (!i.spec?.declared) for (const n of i.spec?.needs ?? []) variableNames.add(n);
  const variables: Record<string, string | null> = {};
  for (const name of [...variableNames].sort()) {
    variables[name] = resolve(name, (o) => o.variables?.[name]);
  }
  const content = gitlabCaller({
    includes,
    variables,
    stages: exemplar?.stages,
    workflow: exemplar?.gitlabWorkflow,
    todo,
  });
  return {
    mode: 'shared',
    reason,
    provider: 'gitlab',
    path: '.gitlab-ci.yml',
    content,
    template,
    todo,
  };
}

/** How the exemplar calls a configured template: its job id, permissions, and secrets. */
function pickCallDetails(exemplar: RepoCi, configured: SharedUse): Partial<SharedUse> {
  const same = exemplar.uses.find((u) => key(u) === key(configured));
  if (!same) return {};
  return {
    ...(same.job ? { job: same.job } : {}),
    ...(same.permissions !== undefined ? { permissions: same.permissions } : {}),
    ...(same.secrets ? { secrets: same.secrets } : {}),
  };
}

const indent = (text: string, spaces: number) =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => (l ? ' '.repeat(spaces) + l : l))
    .join('\n');

const yamlBlock = (key: string, value: unknown, spaces: number) =>
  `${' '.repeat(spaces)}${key}:\n${indent(stringify(value, { nullStr: '' }), spaces + 2)}`;

const valueLine = (name: string, value: string | null, type: string, spaces: number): string => {
  const pad = ' '.repeat(spaces);
  if (value === null) return `${pad}${name}: "" # Set this before merging: see the pull request.`;
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return `${pad}${name}: ${value}`;
  if (type === 'boolean' && /^(true|false)$/.test(value)) return `${pad}${name}: ${value}`;
  return `${pad}${name}: ${JSON.stringify(value)}`;
};

function githubCaller(o: {
  name: string;
  on: unknown;
  permissions: unknown;
  job: string;
  uses: string;
  jobPermissions: unknown;
  secrets: 'inherit' | Record<string, string> | undefined;
  values: Record<string, string | null>;
  types: Record<string, string>;
  todo: unknown[];
}): string {
  const lines = [
    '# Generated by Kodra AI Agent: calls the shared workflow the other repos here use.',
    `name: ${JSON.stringify(o.name)}`,
    '',
    yamlBlock('on', o.on, 0),
    '',
    yamlBlock('permissions', o.permissions, 0),
    '',
    'jobs:',
    `  ${o.job}:`,
    `    uses: ${o.uses}`,
  ];
  if (o.jobPermissions !== undefined) lines.push(yamlBlock('permissions', o.jobPermissions, 4));
  if (o.secrets === 'inherit') lines.push('    secrets: inherit');
  else if (o.secrets && Object.keys(o.secrets).length > 0) {
    lines.push('    secrets:');
    for (const [k, v] of Object.entries(o.secrets)) lines.push(`      ${k}: ${JSON.stringify(v)}`);
  }
  const entries = Object.entries(o.values);
  if (entries.length > 0) {
    lines.push('    with:');
    for (const [k, v] of entries) lines.push(valueLine(k, v, o.types[k] ?? 'string', 6));
  }
  return `${lines.join('\n')}\n`;
}

function gitlabCaller(o: {
  includes: { call: SharedUse; inputs: Record<string, string | null> }[];
  variables: Record<string, string | null>;
  stages: unknown;
  workflow: unknown;
  todo: unknown[];
}): string {
  const lines = [
    '# Generated by Kodra AI Agent: includes the shared pipeline the other projects here use.',
    'include:',
  ];
  for (const { call, inputs } of o.includes) {
    lines.push(`  - project: ${JSON.stringify(call.source)}`);
    if (call.ref) lines.push(`    ref: ${JSON.stringify(call.ref)}`);
    if (call.files.length === 1) lines.push(`    file: ${JSON.stringify(call.files[0])}`);
    else {
      lines.push('    file:');
      for (const f of call.files) lines.push(`      - ${JSON.stringify(f)}`);
    }
    const entries = Object.entries(inputs);
    if (entries.length > 0) {
      lines.push('    inputs:');
      for (const [k, v] of entries) lines.push(valueLine(k, v, 'string', 6));
    }
  }
  if (o.stages !== undefined) lines.push('', yamlBlock('stages', o.stages, 0));
  if (o.workflow !== undefined) lines.push('', yamlBlock('workflow', o.workflow, 0));
  const vars = Object.entries(o.variables);
  if (vars.length > 0) {
    lines.push('', 'variables:');
    for (const [k, v] of vars) lines.push(valueLine(k, v, 'string', 2));
  }
  return `${lines.join('\n')}\n`;
}
