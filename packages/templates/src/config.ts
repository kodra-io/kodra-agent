import { dependencyIssues, getModelProvider, parseAgentConfig } from '@kodra-agent/connectors';
import {
  DEFAULT_AUDIT_PATH,
  ENTRY_NAME,
  entryEnvVar,
  entrySecretWanted,
  formatSecretRef,
  isConsoleApprover,
  isSecretRequired,
  isTimeZone,
  minuteOfDay,
  policyProblems,
  resolvePolicy,
  SCHEMA_API_VERSION,
  type ConfigField,
  type EffectivePolicy,
  type EntriesField,
  type EntryField,
  type Manifest,
  type PolicyProblem,
  type PolicySource,
  type SecretSpec,
} from '@kodra-agent/schema';
import { Document, isScalar } from 'yaml';
import {
  enabledConnectors,
  splitList,
  type AgentDraft,
  type ConnectorDraft,
  type EntryDraft,
} from './draft.ts';

export type StepId = 'profile' | 'start' | 'model' | 'connectors' | 'environments' | 'review';

/** A problem with the draft, keyed to the UI field it belongs to. The UI localizes `code`. */
export type DraftIssue = { field: string; step: StepId } & (
  | { code: 'required' }
  | { code: 'url' }
  | { code: 'pattern'; hint?: string | undefined }
  | { code: 'integer-range'; min: number; max: number }
  | { code: 'name-format' }
  | { code: 'entry-name' }
  | { code: 'entry-duplicate'; value: string }
  | { code: 'approver-format'; value: string }
  | { code: 'approver-console-off'; value: string }
  | { code: 'dependency'; message: string }
  | { code: 'coming-soon' }
  | { code: 'environment-name' }
  | { code: 'namespace-format'; value: string }
  | { code: 'repo-format'; value: string }
  | { code: 'time-format' }
  | { code: 'timezone' }
  | { code: 'policy'; problem: PolicyProblem }
  | { code: 'schema'; message: string }
);

const NAME = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
const ENVIRONMENT_NAME = /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/;
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const APPROVER =
  /^(@[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[UW][A-Z0-9]{2,}|console:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/;

/** The reference written into kodra-agent.yaml for a secret. */
export function secretRefFor(secret: SecretSpec): string {
  return secret.defaultRef === 'file'
    ? formatSecretRef({ scheme: 'file', path: secret.defaultFilePath ?? `/secrets/${secret.key}` })
    : formatSecretRef({ scheme: 'env', name: secret.envVar });
}

/** Secrets an enabled connector or the model will ask for. */
/** Secrets the config names: required ones (for this target), plus the optional ones chosen. */
export function includedSecrets(
  manifest: Manifest,
  optionalChosen: readonly string[],
  target: 'compose' | 'kubernetes',
): SecretSpec[] {
  return manifest.secrets.filter(
    (s) => isSecretRequired(s, target) || optionalChosen.includes(s.key),
  );
}

/** An entry's value for one of its fields, as the config holds it; undefined when empty. */
function entryFieldValue(f: EntryField, raw: string | undefined): unknown {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (f.kind === 'integer') return /^-?\d+$/.test(value) ? Number(value) : value;
  if (f.kind === 'boolean') return value === 'true';
  return value;
}

/**
 * An `entries` setting as kodra-agent.yaml holds it. Secrets are references to the variable
 * named for the entry (KODRA_DB_ORDERS_PASSWORD), the only ones the schema accepts.
 */
export function entriesValue(
  field: EntriesField,
  entries: readonly EntryDraft[],
): Record<string, unknown>[] {
  return entries.map((entry) => {
    const name = (entry['name'] ?? '').trim();
    const out: Record<string, unknown> = { name };
    for (const f of field.fields) {
      if (f.kind === 'secret') {
        if (entrySecretWanted(f, entry) && name !== '') {
          out[f.key] = formatSecretRef({ scheme: 'env', name: entryEnvVar(field, name, f.envVar) });
        }
        continue;
      }
      const value = entryFieldValue(f, entry[f.key]);
      if (value !== undefined) out[f.key] = value;
    }
    return out;
  });
}

/**
 * The secrets a connector's entries name (a password per database), as the agent's `init`
 * asks for them: optional, keyed `<entry>.<field>`, checked with the connector's health probe.
 */
export function entrySecrets(
  manifest: Manifest,
  connector: ConnectorDraft | undefined,
): SecretSpec[] {
  const out: SecretSpec[] = [];
  for (const field of manifest.configFields) {
    if (field.kind !== 'entries') continue;
    for (const entry of connector?.entries?.[field.key] ?? []) {
      const name = (entry['name'] ?? '').trim();
      if (!ENTRY_NAME.test(name)) continue;
      for (const f of field.fields) {
        if (f.kind !== 'secret' || !entrySecretWanted(f, entry)) continue;
        out.push({
          key: `${name}.${f.key}`,
          envVar: entryEnvVar(field, name, f.envVar),
          defaultRef: 'env',
          required: false,
          description: f.description,
          howToCreate: f.howToCreate,
          minimumScopes: {},
          probe: manifest.healthProbe ?? `${manifest.id}.connect`,
        });
      }
    }
  }
  return out;
}

function fieldValue(field: ConfigField, raw: string | undefined): unknown {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  switch (field.kind) {
    case 'string-list':
      return splitList(value);
    case 'entries':
      return undefined;
    case 'integer':
      return /^-?\d+$/.test(value) ? Number(value) : value;
    default:
      return value;
  }
}

function fieldsObject(fields: readonly ConfigField[], raw: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = fieldValue(field, raw[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

/** The console's port, in the container and on the host (compose maps 127.0.0.1 only). */
export const CONSOLE_PORT = 8081;

/** The draft's profile, approvers, and environments, as resolvePolicy takes them. */
export function policySource(draft: AgentDraft): PolicySource {
  const expires = Number(draft.policy.expiresAfterMinutes.trim());
  return {
    profile: draft.profile,
    policy: {
      approvals: {
        approvers: splitList(draft.policy.approvers),
        expiresAfterMinutes: Number.isInteger(expires) && expires > 0 ? expires : 15,
      },
    },
    environments: draft.environments.map((env) => {
      const approvers = splitList(env.approvers);
      return {
        name: env.name.trim(),
        production: env.production,
        namespaces: splitList(env.namespaces),
        repos: splitList(env.repos),
        ...(approvers.length > 0 ? { approvers } : {}),
      };
    }),
  };
}

/** The approval rules the agent will apply, for the review step and the bundle README. */
export function effectivePolicy(draft: AgentDraft): EffectivePolicy {
  return resolvePolicy(policySource(draft));
}

/** The kodra-agent.yaml content for a draft, as a plain object. */
export function draftToConfig(draft: AgentDraft): Record<string, unknown> {
  const provider = getModelProvider(draft.model.provider);
  const model: Record<string, unknown> = {
    provider: draft.model.provider,
    name: draft.model.name.trim(),
    ...fieldsObject(provider?.configFields ?? [], draft.model.fields),
  };
  for (const secret of provider?.secrets ?? []) model[secret.key] = secretRefFor(secret);

  const connectorsOut: Record<string, unknown> = {};
  for (const manifest of enabledConnectors(draft)) {
    const entry = draft.connectors[manifest.id];
    if (!entry) continue;
    const out: Record<string, unknown> = { enabled: true };
    if (manifest.accessLevels.length > 0) out['access'] = entry.access;
    const config = fieldsObject(manifest.configFields, entry.config);
    for (const field of manifest.configFields) {
      const list = field.kind === 'entries' ? (entry.entries?.[field.key] ?? []) : [];
      if (field.kind === 'entries' && list.length > 0) {
        config[field.key] = entriesValue(field, list);
      }
    }
    if (Object.keys(config).length > 0) out['config'] = config;
    const secrets = includedSecrets(manifest, entry.optionalSecrets, draft.target);
    if (secrets.length > 0) {
      out['secrets'] = Object.fromEntries(secrets.map((s) => [s.key, secretRefFor(s)]));
    }
    connectorsOut[manifest.id] = out;
  }

  const expires = draft.policy.expiresAfterMinutes.trim();
  const environments = policySource(draft).environments.map((env) => ({
    name: env.name,
    ...(env.production ? { production: true } : {}),
    ...(env.namespaces.length > 0 ? { namespaces: env.namespaces } : {}),
    ...(env.repos.length > 0 ? { repos: env.repos } : {}),
    ...(env.approvers ? { approvers: env.approvers } : {}),
  }));
  return {
    apiVersion: SCHEMA_API_VERSION,
    kind: 'Agent',
    metadata: { name: draft.name.trim() },
    spec: {
      profile: draft.profile,
      target: draft.target,
      model,
      connectors: connectorsOut,
      policy: {
        approvals: {
          required: true,
          approvers: splitList(draft.policy.approvers),
          expiresAfterMinutes: /^\d+$/.test(expires) ? Number(expires) : expires,
        },
        destructiveActions: draft.policy.destructiveActions,
      },
      ...(environments.length > 0 ? { environments } : {}),
      audit: { path: DEFAULT_AUDIT_PATH },
      telemetry: { enabled: false },
      console: { enabled: draft.console.enabled, port: CONSOLE_PORT, chat: draft.console.chat },
      ...(draft.checks.enabled
        ? {
            checks: {
              schedules: [
                {
                  name: 'daily',
                  at: draft.checks.at.trim(),
                  ...(draft.checks.days === 'weekdays'
                    ? { days: ['mon', 'tue', 'wed', 'thu', 'fri'] }
                    : {}),
                  timezone: draft.checks.timezone.trim(),
                },
              ],
            },
          }
        : {}),
    },
  };
}

export function configYaml(draft: AgentDraft): string {
  const header = [
    '# Kodra AI Agent configuration, generated by the configurator.',
    '# Secret values never go in this file, only references to where they live.',
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/kodra-io/kodra-agent/main/schema/kodra-agent.schema.json',
  ].join('\n');
  const doc = new Document(draftToConfig(draft));
  // "09:00" stays a string for YAML 1.1 readers too, which would read 09:00 as 540.
  const at = doc.getIn(['spec', 'checks', 'schedules', 0, 'at'], true);
  if (isScalar(at)) at.type = 'QUOTE_DOUBLE';
  return `${header}\n${doc.toString({ lineWidth: 0 })}`;
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validateField(field: ConfigField, raw: string | undefined, id: string, step: StepId) {
  const value = (raw ?? '').trim();
  const hasDefault = 'default' in field && field.default !== undefined;
  if (value === '') {
    return field.required && !hasDefault ? [{ field: id, step, code: 'required' as const }] : [];
  }
  switch (field.kind) {
    case 'url': {
      return isHttpUrl(value) ? [] : [{ field: id, step, code: 'url' as const }];
    }
    case 'string': {
      const ok = !field.pattern || new RegExp(field.pattern).test(value);
      return ok ? [] : [{ field: id, step, code: 'pattern' as const, hint: field.patternHint }];
    }
    case 'string-list': {
      const items = splitList(value);
      const ok = !field.pattern || items.every((i) => new RegExp(field.pattern ?? '').test(i));
      return ok ? [] : [{ field: id, step, code: 'pattern' as const, hint: field.patternHint }];
    }
    case 'integer': {
      const n = Number(value);
      const ok = /^\d+$/.test(value) && n >= field.min && n <= field.max;
      return ok
        ? []
        : [{ field: id, step, code: 'integer-range' as const, min: field.min, max: field.max }];
    }
    case 'entries':
      // Checked entry by entry: validateEntries.
      return [];
  }
}

/** Every problem with an `entries` setting's entries, keyed `<id>.<index>.<field>`. */
function validateEntries(field: EntriesField, entries: readonly EntryDraft[], id: string) {
  const step = 'connectors' as const;
  const issues: DraftIssue[] = [];
  const names = entries.map((e) => (e['name'] ?? '').trim());
  entries.forEach((entry, i) => {
    const at = (key: string) => `${id}.${String(i)}.${key}`;
    const name = names[i] ?? '';
    if (name === '') issues.push({ field: at('name'), step, code: 'required' });
    else if (!ENTRY_NAME.test(name) || name.length > 40) {
      issues.push({ field: at('name'), step, code: 'entry-name' });
    } else if (names.indexOf(name) !== i) {
      issues.push({ field: at('name'), step, code: 'entry-duplicate', value: name });
    }
    for (const f of field.fields) {
      if (f.kind === 'secret' || f.kind === 'boolean') continue;
      const value = (entry[f.key] ?? '').trim();
      if (value === '') {
        const hasDefault = 'default' in f && f.default !== undefined;
        const withOther =
          'requiredWith' in f &&
          f.requiredWith !== undefined &&
          (entry[f.requiredWith] ?? '').trim() !== '';
        if ((f.required && !hasDefault) || withOther) {
          issues.push({ field: at(f.key), step, code: 'required' });
        }
        continue;
      }
      if (f.kind === 'string' && f.pattern && !new RegExp(f.pattern).test(value)) {
        issues.push({ field: at(f.key), step, code: 'pattern', hint: f.patternHint });
      }
      if (f.kind === 'integer') {
        const n = Number(value);
        if (!/^\d+$/.test(value) || n < f.min || n > f.max) {
          issues.push({ field: at(f.key), step, code: 'integer-range', min: f.min, max: f.max });
        }
      }
      if (f.kind === 'choice' && !f.options.includes(value)) {
        issues.push({ field: at(f.key), step, code: 'pattern', hint: undefined });
      }
    }
  });
  return issues;
}

/**
 * Every problem that blocks the download, keyed to UI fields. The generated YAML is also run
 * through the real schema, so anything the field checks miss still blocks the download.
 */
export function validateDraft(draft: AgentDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (name === '') issues.push({ field: 'name', step: 'start', code: 'required' });
  else if (!NAME.test(name)) issues.push({ field: 'name', step: 'start', code: 'name-format' });

  if (draft.model.name.trim() === '') {
    issues.push({ field: 'model.name', step: 'model', code: 'required' });
  }
  for (const field of getModelProvider(draft.model.provider)?.configFields ?? []) {
    issues.push(
      ...validateField(field, draft.model.fields[field.key], `model.${field.key}`, 'model'),
    );
  }

  const enabled = enabledConnectors(draft);
  for (const manifest of enabled) {
    if (manifest.status === 'coming-soon') {
      issues.push({ field: `connector.${manifest.id}`, step: 'connectors', code: 'coming-soon' });
    }
    const entry = draft.connectors[manifest.id];
    for (const field of manifest.configFields) {
      if (field.kind === 'entries') {
        issues.push(
          ...validateEntries(
            field,
            entry?.entries?.[field.key] ?? [],
            `connector.${manifest.id}.${field.key}`,
          ),
        );
        continue;
      }
      issues.push(
        ...validateField(
          field,
          entry?.config[field.key],
          `connector.${manifest.id}.${field.key}`,
          'connectors',
        ),
      );
    }
  }
  for (const dep of dependencyIssues(enabled.map((m) => m.id))) {
    issues.push({
      field: `connector.${dep.connector}`,
      step: 'connectors',
      code: 'dependency',
      message: dep.message,
    });
  }

  const approvers = splitList(draft.policy.approvers);
  if (approvers.length === 0) {
    issues.push({ field: 'policy.approvers', step: 'review', code: 'required' });
  }
  for (const value of approvers.filter((a) => !APPROVER.test(a))) {
    issues.push({ field: 'policy.approvers', step: 'review', code: 'approver-format', value });
  }
  if (!draft.console.enabled) {
    for (const value of approvers.filter((a) => APPROVER.test(a) && isConsoleApprover(a))) {
      issues.push({
        field: 'policy.approvers',
        step: 'review',
        code: 'approver-console-off',
        value,
      });
    }
  }
  if (draft.checks.enabled) {
    if (minuteOfDay(draft.checks.at.trim()) === null) {
      issues.push({ field: 'checks.at', step: 'review', code: 'time-format' });
    }
    const zone = draft.checks.timezone.trim();
    if (zone === '' || !isTimeZone(zone)) {
      issues.push({ field: 'checks.timezone', step: 'review', code: 'timezone' });
    }
  }
  draft.environments.forEach((env, i) => {
    const at = (key: string) => `environment.${String(i)}.${key}`;
    const name = env.name.trim();
    if (name === '') issues.push({ field: at('name'), step: 'environments', code: 'required' });
    else if (!ENVIRONMENT_NAME.test(name)) {
      issues.push({ field: at('name'), step: 'environments', code: 'environment-name' });
    }
    for (const value of splitList(env.namespaces).filter((v) => !NAMESPACE.test(v))) {
      issues.push({
        field: at('namespaces'),
        step: 'environments',
        code: 'namespace-format',
        value,
      });
    }
    for (const value of splitList(env.repos).filter((v) => !REPO.test(v))) {
      issues.push({ field: at('repos'), step: 'environments', code: 'repo-format', value });
    }
    for (const value of splitList(env.approvers).filter((a) => !APPROVER.test(a))) {
      issues.push({ field: at('approvers'), step: 'environments', code: 'approver-format', value });
    }
  });
  // Rules nobody can satisfy, shared names, empty environments: the same checks the agent runs.
  // With no approvers yet, "required" says it; counting them would only repeat it.
  const counted = approvers.length > 0;
  for (const problem of policyProblems(policySource(draft))) {
    if (!counted && problem.code.startsWith('needs-')) continue;
    const [, section, index, key] = problem.path;
    const inEnvironment = section === 'environments' && typeof index === 'number';
    issues.push({
      field: inEnvironment ? `environment.${String(index)}.${String(key)}` : 'policy.approvers',
      step: inEnvironment ? 'environments' : 'review',
      code: 'policy',
      problem,
    });
  }

  const expires = draft.policy.expiresAfterMinutes.trim();
  if (!/^\d+$/.test(expires) || Number(expires) < 1 || Number(expires) > 1440) {
    issues.push({
      field: 'policy.expiresAfterMinutes',
      step: 'review',
      code: 'integer-range',
      min: 1,
      max: 1440,
    });
  }

  if (issues.length === 0) {
    const result = parseAgentConfig(configYaml(draft));
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({
          field: 'schema',
          step: 'review',
          code: 'schema',
          message: `${issue.path}: ${issue.message}`,
        });
      }
    }
  }
  return issues;
}
