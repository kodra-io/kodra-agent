import type { AccessLevel, ToolGuard, ToolRisk } from '@kodra-agent/schema';
import { parseAllDocuments } from 'yaml';

/** The agent's own Kubernetes objects, from the chart's KODRA_AGENT_SELF_* variables. */
export interface SelfTarget {
  namespace: string;
  /** Exact names; pods are matched by the `<name>-` prefix too. */
  names: readonly string[];
}

export function selfTarget(env: Readonly<Record<string, string | undefined>>): SelfTarget | null {
  const namespace = env['KODRA_AGENT_SELF_NAMESPACE'];
  const names = (env['KODRA_AGENT_SELF_NAMES'] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return namespace && names.length > 0 ? { namespace, names } : null;
}

export type Risk = ToolRisk | 'unclassified';

export type Decision = { kind: 'allow' } | { kind: 'approve' } | { kind: 'block'; reason: string };

export interface PolicyInput {
  risk: Risk;
  /** The connector's access level; undefined for connectors without access levels. */
  access: AccessLevel | undefined;
  destructiveActions: 'deny' | 'require-approval';
  guards: readonly ToolGuard[];
  args: Readonly<Record<string, unknown>>;
  settings: Readonly<Record<string, unknown>>;
  /** Settings of connectors this one requires, for guards with `from`. */
  sharedSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Default branch per repo (lowercase `owner/repo` or `group/project`), looked up at
   * startup. null means the lookup failed, which blocks writes to that repo.
   */
  defaultBranches?: ReadonlyMap<string, string | null>;
  /** The agent's own objects, when it runs in a cluster; null or missing elsewhere. */
  self?: SelfTarget | null | undefined;
}

/**
 * Whether a value is in a list setting. With `prefix`, an entry also covers what is under it
 * (`team-a` covers `team-a/api`); such values must be plain paths, so `team-a/../other` or
 * an encoded slash cannot step outside an entry.
 */
export function inList(value: string, list: readonly string[], prefix: boolean): boolean {
  if (list.includes(value)) return true;
  if (!prefix) return false;
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..') || /[\\%]/.test(value))
    return false;
  return list.some((entry) => {
    const base = entry.replace(/\/+$/, '');
    return base !== '' && value.startsWith(`${base}/`);
  });
}

/**
 * The single place that decides whether a tool call may run (SPEC section 8):
 * read runs; write needs approval with read-write access, else blocked; destructive is
 * blocked unless policy allows it with approval; anything unclassified is blocked.
 * Guards run first, so a read outside the allowed namespaces is still blocked.
 */
export function decide(input: PolicyInput): Decision {
  if (input.risk === 'unclassified') {
    return { kind: 'block', reason: 'this tool has no risk classification' };
  }
  for (const guard of input.guards) {
    const problem = checkGuard(guard, input);
    if (problem) return { kind: 'block', reason: problem };
  }
  switch (input.risk) {
    case 'read':
      return { kind: 'allow' };
    case 'write':
      return input.access === 'read-write-approved'
        ? { kind: 'approve' }
        : { kind: 'block', reason: 'this connector is read-only' };
    case 'destructive':
      if (input.destructiveActions !== 'require-approval') {
        return { kind: 'block', reason: 'destructive actions are denied by policy' };
      }
      return input.access === 'read-write-approved'
        ? { kind: 'approve' }
        : { kind: 'block', reason: 'this connector is read-only' };
  }
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

function listSetting(settings: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = settings[key];
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** `owner/repo` from the tool's arguments, or null when it is missing or not a string. */
function repoFrom(
  args: Readonly<Record<string, unknown>>,
  repoArg: string,
  ownerArg?: string,
): string | null {
  const repo = args[repoArg];
  if (typeof repo !== 'string' || repo === '') return null;
  if (!ownerArg) return repo;
  const owner = args[ownerArg];
  return typeof owner === 'string' && owner !== '' ? `${owner}/${repo}` : null;
}

/** The objects a call names: one from its arguments, or every object in a manifest argument. */
function objectsOf(
  guard: Extract<ToolGuard, { kind: 'not-self' }>,
  args: Readonly<Record<string, unknown>>,
): { namespace: string | null; name: string | null }[] | null {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  if (!guard.resourceArg) {
    return [
      {
        namespace: str(args[guard.namespaceArg]),
        name: guard.nameArg ? str(args[guard.nameArg]) : null,
      },
    ];
  }
  const text = args[guard.resourceArg];
  if (typeof text !== 'string') return null;
  try {
    return parseAllDocuments(text).flatMap((doc) => {
      if (doc.errors.length > 0) throw new Error('bad manifest');
      const value: unknown = doc.toJS();
      const items = Array.isArray(value) ? value : [value];
      return items
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((v) => {
          const meta = (v['metadata'] ?? {}) as Record<string, unknown>;
          return {
            namespace: str(meta['namespace']) ?? str(args[guard.namespaceArg]),
            name: str(meta['name']),
          };
        });
    });
  } catch {
    return null;
  }
}

function selfProblem(
  guard: Extract<ToolGuard, { kind: 'not-self' }>,
  input: PolicyInput,
): string | null {
  const self = input.self;
  if (!self) return null;
  const objects = objectsOf(guard, input.args);
  if (objects === null) return 'cannot tell which objects this changes, so it is blocked';
  for (const object of objects) {
    if ((object.namespace ?? self.namespace) !== self.namespace) continue;
    const name = object.name;
    if (name === null || self.names.some((own) => name === own || name.startsWith(`${own}-`))) {
      return `this would change the agent itself (${name ?? `namespace ${self.namespace}`}); the agent never changes its own deployment, config, or secrets`;
    }
  }
  return null;
}

function checkGuard(guard: ToolGuard, input: PolicyInput): string | null {
  const { args, settings } = input;
  switch (guard.kind) {
    case 'not-self':
      return selfProblem(guard, input);
    case 'arg-in-setting': {
      const value = args[guard.arg];
      if (isBlank(value)) return guard.required ? `${guard.arg} is required` : null;
      const list = listSetting(settings, guard.setting);
      return typeof value === 'string' && inList(value, list, guard.prefix === true)
        ? null
        : `${guard.arg} must be ${guard.prefix ? 'one of, or under one of,' : 'one of'} the configured ${guard.setting}: ${list.join(', ') || 'none'}`;
    }
    case 'repo-in-setting': {
      const repo = repoFrom(args, guard.repoArg, guard.ownerArg);
      const source = guard.from ? (input.sharedSettings?.[guard.from] ?? {}) : settings;
      const list = listSetting(source, guard.setting);
      if (repo && list.some((r) => r.toLowerCase() === repo.toLowerCase())) return null;
      return `the repository must be one of the configured ${guard.setting}: ${list.join(', ') || 'none'}`;
    }
    case 'not-default-branch': {
      // Golden rule 6: never push to a default branch. A missing branch means the default.
      const branch = args[guard.branchArg];
      if (typeof branch !== 'string' || branch.trim() === '') {
        return `${guard.branchArg} is required: changes never go to the default branch`;
      }
      const repo = repoFrom(args, guard.repoArg, guard.ownerArg);
      if (!repo) return 'the repository is required';
      const defaultBranch = input.defaultBranches?.get(repo.toLowerCase());
      if (defaultBranch === undefined || defaultBranch === null) {
        return `the default branch of ${repo} is unknown, so changes to it are blocked`;
      }
      const normalize = (b: string) =>
        b
          .trim()
          .replace(/^refs\/heads\//, '')
          .toLowerCase();
      return normalize(branch) === normalize(defaultBranch)
        ? `${branch} is the default branch of ${repo}; changes go through a pull request on another branch`
        : null;
    }
  }
}

/**
 * The namespaces and repos a call touches, read from its guards (PLAN-v0.2 M10), so the call
 * can be placed in an environment. Arguments that are missing touch nothing.
 */
export function touchedBy(
  guards: readonly ToolGuard[],
  args: Readonly<Record<string, unknown>>,
): { namespaces: string[]; repos: string[] } {
  const namespaces = new Set<string>();
  const repos = new Set<string>();
  for (const guard of guards) {
    if (guard.kind === 'arg-in-setting') {
      const value = args[guard.arg];
      if (guard.scope === 'namespace' && typeof value === 'string' && value !== '') {
        namespaces.add(value);
      }
    } else if (guard.kind === 'not-self') {
      // Tools without a namespace allowlist still name a namespace, which places them.
      for (const object of objectsOf(guard, args) ?? []) {
        if (object.namespace) namespaces.add(object.namespace);
      }
    } else {
      const repo = repoFrom(args, guard.repoArg, guard.ownerArg);
      if (repo) repos.add(repo);
    }
  }
  return { namespaces: [...namespaces], repos: [...repos] };
}

/**
 * The limits a tool's guards set, in words the model can follow up front (for example
 * "namespace must be one of: dev"), so it does not spend steps on calls the policy blocks.
 */
export function describeGuards(
  guards: readonly ToolGuard[],
  settings: Readonly<Record<string, unknown>>,
  sharedSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string[] {
  const out: string[] = [];
  for (const guard of guards) {
    switch (guard.kind) {
      case 'arg-in-setting': {
        const list = listSetting(settings, guard.setting);
        out.push(
          `${guard.arg} ${guard.required ? 'is required and ' : ''}must be ${guard.prefix ? 'one of, or under one of' : 'one of'}: ${list.join(', ') || 'none configured'}`,
        );
        break;
      }
      case 'repo-in-setting': {
        const source = guard.from ? (sharedSettings?.[guard.from] ?? {}) : settings;
        const list = listSetting(source, guard.setting);
        const arg = guard.ownerArg ? `${guard.ownerArg}/${guard.repoArg}` : guard.repoArg;
        out.push(`${arg} must be one of: ${list.join(', ') || 'none configured'}`);
        break;
      }
      case 'not-default-branch':
        out.push(`${guard.branchArg} must be a new branch, never the default branch`);
        break;
      case 'not-self':
        out.push("never the agent's own deployment, pods, config, or secrets");
        break;
    }
  }
  return [...new Set(out)];
}
