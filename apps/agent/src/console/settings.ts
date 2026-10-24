import { modelDestination, policyDiffers } from './policy-gate.ts';
import { approverNames, listSlackUsers, matchNames } from '../slack/names.ts';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  connectors as allConnectors,
  getConnector,
  getModelProvider,
  modelProviders,
  parseAgentConfig,
} from '@kodra-agent/connectors';
import {
  parseSecretRef,
  defaultDetectors,
  entriesOf,
  entryEnvVar,
  entrySecretWanted,
  type EntriesField,
  fillSteps,
  type FilledStep,
  formatIssue,
  isConsoleApprover,
  isSecretRequired,
  type AccessLevel,
  type AgentConfig,
  type ConfigField,
  type Manifest,
  type SecretFormat,
} from '@kodra-agent/schema';
import { secretRefFor } from '@kodra-agent/templates';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { AuditLog, AuditRecord } from '../audit.ts';
import { components, secretLabel, type Component, type SecretUse } from '../config.ts';
import { createModel } from '../llm.ts';
import { ollamaContext, type ContextWarning } from '../model-context.ts';
import {
  listProviderModels,
  modelOptions,
  testModel,
  type ListContext,
  type ModelOptionsView,
} from '../model-options.ts';
import { unifiedDiff } from '../diff.ts';
import type { KubernetesFactory } from '../kubernetes.ts';
import { probeIds, runProbe, type ProbeContext, type ProbeResult } from '../probes.ts';
import type { Redactor } from '../redactor.ts';
import { resolveAll } from '../secrets.ts';
import type { ConfigBackend } from './config-backend.ts';
import {
  caCertificates,
  secretFileName,
  secretParts,
  secretShapeProblem,
  usesAwsExec,
} from './secret-files.ts';

/**
 * Settings from the console (M8c): an approver edits kodra-agent.yaml through a patch that
 * keeps the file's comments, sees the diff and any access it adds, and saves; the agent keeps
 * the previous file (Undo puts it back), audits the change, and restarts to apply it.
 * Secrets are write-only: checked first, then written to .env (or the agent's Secret). Where it
 * all lives is the ConfigBackend: files on Docker Compose, the agent's own ConfigMap and Secret
 * on Kubernetes.
 */

export interface ConnectorPatch {
  enabled?: boolean;
  access?: AccessLevel;
  /** Setting values by key; null removes a setting. */
  config?: Record<string, unknown>;
  /** Keep a credential broader than the agent needs (M29); null removes it. */
  allowBroadCredentials?: boolean | null;
}

/** Approval rules the profile decides unless set; null removes one (M30b). */
export interface RulesPatch {
  minApprovers?: number | null;
  allowSelfApproval?: boolean | null;
  requireChangeRef?: boolean | null;
  changeRefPattern?: string | null;
}

export interface SettingsPatch {
  connectors?: Record<string, ConnectorPatch>;
  policy?: {
    approvers?: string[];
    expiresAfterMinutes?: number;
    destructiveActions?: 'deny' | 'require-approval';
  } & RulesPatch;
  /** starter, team, or strict (M10). */
  profile?: string;
  /** Every environment, replacing the list (M30b). */
  environments?: Record<string, unknown>[];
  checks?: {
    schedules?: { name: string; at: string; days?: string[]; timezone: string }[];
    quietWhenClean?: boolean;
  };
  monitoring?: { maxConcurrent?: number; maxPerHour?: number; cooldownMinutes?: number };
  /** Hosts that skip the proxy; the proxy URLs themselves are secrets (settings/proxy). */
  network?: { noProxy?: string | null };
  /** null for the profile's detectors. */
  dataProtection?: { redact?: string[] | null; patterns?: { name: string; regex: string }[] };
  /** Named models (M13), each like the model; null removes one. */
  models?: Record<
    string,
    { provider: string; name: string; config?: Record<string, string> } | null
  >;
  ship?: { baseImageMirrors?: Record<string, string> };
  metrics?: { enabled?: boolean; port?: number };
  tracing?: { enabled?: boolean; endpoint?: string | null };
  audit?: { stdout?: boolean };
  /**
   * The model's name; with `provider`, the whole model is replaced: that provider, its
   * settings from `config`, and references to its secrets (the values go to .env).
   */
  model?: { name?: string; provider?: string; config?: Record<string, string> };
  limits?: {
    maxSteps?: number;
    tokenBudget?: number;
    timeoutMinutes?: number;
    /** null removes the budget. */
    monthlyBudgetUsd?: number | null;
    maxWritesPerHour?: number;
  };
  console?: { chat?: boolean };
}

/** What a change gives the agent that it did not have, for the approver to notice. */
export type AccessChange =
  | { code: 'enabled'; connector: string }
  | { code: 'write'; connector: string }
  | { code: 'scope'; connector: string; field: string; added: string[] }
  | { code: 'approver'; approver: string }
  | { code: 'destructive' }
  | { code: 'chat' }
  /** Questions, logs, and tool output now go to another model provider or endpoint. */
  | { code: 'model'; from: string; to: string }
  /** A credential broader than the agent needs is kept (M29). */
  | { code: 'broad'; connector: string }
  /** Kinds of customer data the model now sees unmasked (M13). */
  | { code: 'unmasked'; detectors: string[] }
  /** Another model provider some environment's data can go to (M13). */
  | { code: 'named-model'; name: string }
  /** Traces (names and durations) now go to this endpoint. */
  | { code: 'tracing'; endpoint: string };

export interface Preview {
  ok: boolean;
  errors: string[];
  diff: string;
  base: string;
  moreAccess: AccessChange[];
  changed: string[];
  /** Whether it changes who may change what (M11): announced, or held for a second approver. */
  policy: boolean;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const RULE_KEYS = [
  'minApprovers',
  'allowSelfApproval',
  'requireChangeRef',
  'changeRefPattern',
] as const;

/** Applies a patch to the YAML text, keeping its comments and layout. */
export function patchConfigText(text: string, patch: SettingsPatch): string {
  const doc = parseDocument(text);
  const set = (path: (string | number)[], value: unknown) => {
    if (value === null) doc.deleteIn(path);
    else if (value !== undefined) doc.setIn(path, value);
  };
  for (const [id, c] of Object.entries(patch.connectors ?? {})) {
    const manifest = getConnector(id);
    if (!manifest) throw new Error(`unknown connector ${id}`);
    const base = ['spec', 'connectors', id];
    if (!doc.hasIn(base)) {
      // A new entry: the default access and the secrets it needs, as the configurator writes.
      const entry: Record<string, unknown> = { enabled: c.enabled ?? true };
      const access = c.access ?? manifest.accessLevels[0];
      if (access) entry['access'] = access;
      const secrets = manifest.secrets.filter((s) => s.required);
      if (secrets.length > 0) {
        entry['secrets'] = Object.fromEntries(secrets.map((s) => [s.key, secretRefFor(s)]));
      }
      doc.setIn(base, doc.createNode(entry));
    } else {
      set([...base, 'enabled'], c.enabled);
      set([...base, 'access'], c.access);
    }
    if (c.allowBroadCredentials !== undefined) {
      set([...base, 'allowBroadCredentials'], c.allowBroadCredentials === true ? true : null);
    }
    for (const [key, value] of Object.entries(c.config ?? {})) {
      const field = manifest.configFields.find((f) => f.key === key);
      set(
        [...base, 'config', key],
        field?.kind === 'entries' && Array.isArray(value)
          ? entriesWithRefs(field, value, doc.getIn([...base, 'config', key]))
          : value,
      );
    }
  }
  set(['spec', 'policy', 'approvals', 'approvers'], patch.policy?.approvers);
  set(['spec', 'policy', 'approvals', 'expiresAfterMinutes'], patch.policy?.expiresAfterMinutes);
  set(['spec', 'policy', 'destructiveActions'], patch.policy?.destructiveActions);
  for (const key of RULE_KEYS) {
    if (patch.policy && key in patch.policy) {
      const value = patch.policy[key];
      set(['spec', 'policy', 'approvals', key], value === '' ? null : value);
    }
  }
  set(['spec', 'profile'], patch.profile);
  if (patch.environments !== undefined) {
    doc.setIn(['spec', 'environments'], doc.createNode(patch.environments));
  }
  if (patch.checks?.schedules !== undefined) {
    doc.setIn(['spec', 'checks', 'schedules'], doc.createNode(patch.checks.schedules));
  }
  set(['spec', 'checks', 'quietWhenClean'], patch.checks?.quietWhenClean);
  for (const key of ['maxConcurrent', 'maxPerHour', 'cooldownMinutes'] as const) {
    set(['spec', 'monitoring', key], patch.monitoring?.[key]);
  }
  if (patch.network && 'noProxy' in patch.network) {
    set(['spec', 'network', 'proxy', 'noProxy'], patch.network.noProxy || null);
  }
  if (patch.dataProtection && 'redact' in patch.dataProtection) {
    const redact = patch.dataProtection.redact;
    set(['spec', 'dataProtection', 'redact'], redact === null ? null : doc.createNode(redact));
  }
  if (patch.dataProtection?.patterns !== undefined) {
    doc.setIn(
      ['spec', 'dataProtection', 'patterns'],
      doc.createNode(patch.dataProtection.patterns),
    );
  }
  for (const [name, model] of Object.entries(patch.models ?? {})) {
    if (model === null) doc.deleteIn(['spec', 'models', name]);
    else doc.setIn(['spec', 'models', name], doc.createNode(modelNode(model)));
  }
  if (patch.ship?.baseImageMirrors !== undefined) {
    doc.setIn(['spec', 'ship', 'baseImageMirrors'], doc.createNode(patch.ship.baseImageMirrors));
  }
  set(['spec', 'metrics', 'enabled'], patch.metrics?.enabled);
  set(['spec', 'metrics', 'port'], patch.metrics?.port);
  set(['spec', 'tracing', 'enabled'], patch.tracing?.enabled);
  if (patch.tracing && 'endpoint' in patch.tracing) {
    set(['spec', 'tracing', 'endpoint'], patch.tracing.endpoint || null);
  }
  set(['spec', 'audit', 'stdout'], patch.audit?.stdout);
  if (patch.model?.provider !== undefined) {
    doc.setIn(['spec', 'model'], doc.createNode(modelNode(patch.model)));
  } else set(['spec', 'model', 'name'], patch.model?.name);
  for (const key of [
    'maxSteps',
    'tokenBudget',
    'timeoutMinutes',
    'monthlyBudgetUsd',
    'maxWritesPerHour',
  ] as const) {
    set(['spec', 'limits', key], patch.limits?.[key]);
  }
  set(['spec', 'console', 'chat'], patch.console?.chat);
  return doc.toString();
}

/**
 * Entries (databases) as the console sends them, with their secrets as references the agent
 * chooses: each entry's own variable, like ${env:KODRA_DB_ORDERS_PASSWORD}. A reference the
 * console sends is never written as is, so nobody can point a database at another secret; a
 * file reference already in the file for the same entry is kept.
 */
export function entriesWithRefs(
  field: EntriesField,
  entries: readonly unknown[],
  current: unknown,
): Record<string, unknown>[] {
  const before = entriesOf(
    current !== null && typeof current === 'object' && 'toJSON' in current
      ? (current as { toJSON: () => unknown }).toJSON()
      : current,
  );
  return entriesOf(entries).map((entry) => {
    const name = String(entry['name']);
    const was = before.find((e) => e['name'] === name);
    const out: Record<string, unknown> = { name };
    for (const f of field.fields) {
      const value = entry[f.key];
      if (f.kind !== 'secret') {
        if (value !== undefined && value !== null && value !== '') out[f.key] = value;
        continue;
      }
      if (!entrySecretWanted(f, entry)) continue;
      const kept = was?.[f.key];
      out[f.key] =
        typeof kept === 'string' && kept.startsWith('${file:')
          ? kept
          : `\${env:${entryEnvVar(field, name, f.envVar)}}`;
    }
    return out;
  });
}

/**
 * Points a connector's secret at where the console saved it (M28): `key` is the manifest's
 * secret, or `<entry>.<field>` for an entry's. The reference is the agent's choice, never the
 * console's. Returns the text unchanged when it already points there.
 */
export function setSecretRef(text: string, manifest: Manifest, key: string, ref: string): string {
  const doc = parseDocument(text);
  const base = ['spec', 'connectors', manifest.id];
  const dot = key.indexOf('.');
  if (dot === -1) {
    if (doc.getIn([...base, 'secrets', key]) === ref) return text;
    doc.setIn([...base, 'secrets', key], ref);
    return doc.toString();
  }
  const [name, field] = [key.slice(0, dot), key.slice(dot + 1)];
  for (const f of manifest.configFields) {
    if (f.kind !== 'entries') continue;
    const list = doc.getIn([...base, 'config', f.key]);
    if (!isSeq(list)) continue;
    const i = list.items.findIndex((item) => isMap(item) && item.get('name') === name);
    if (i === -1) continue;
    if (doc.getIn([...base, 'config', f.key, i, field]) === ref) return text;
    doc.setIn([...base, 'config', f.key, i, field], ref);
    return doc.toString();
  }
  return text;
}

/** Default values of fields, so steps show a port of 22 before anyone sets one. */
function defaults(fields: readonly object[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const { key, default: value } = f as { key: string; default?: unknown };
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** An entry's values for its steps: its fields over their defaults. */
function entryValues(
  manifest: Manifest,
  settings: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  for (const f of manifest.configFields) {
    if (f.kind !== 'entries') continue;
    const entry = entriesOf(settings[f.key]).find((e) => e['name'] === name);
    if (entry) return { ...defaults(f.fields), ...entry };
  }
  return {};
}

/** Each entry's field steps, filled with its values ('' for one not saved yet). */
function entrySteps(
  manifest: Manifest,
  settings: Record<string, unknown>,
  agentName: string,
): Record<string, Record<string, FilledStep[]>> {
  const out: Record<string, Record<string, FilledStep[]>> = {};
  for (const f of manifest.configFields) {
    if (f.kind !== 'entries') continue;
    const fill = (values: Record<string, unknown>) =>
      Object.fromEntries(
        f.fields.flatMap((x) =>
          x.kind === 'string' && x.steps
            ? [[x.key, fillSteps(x.steps, { ...values, agentName })]]
            : [],
        ),
      );
    out[''] = fill(defaults(f.fields));
    for (const entry of entriesOf(settings[f.key])) {
      out[String(entry['name'])] = fill({ ...defaults(f.fields), ...entry });
    }
  }
  return out;
}

/** A secret the config does not refer to yet, where it would go by default. */
function unreferenced(comp: Component, key: string): SecretUse | undefined {
  const spec = comp.manifest.secrets.find((s) => s.key === key);
  if (!spec) return undefined;
  return {
    component: comp.id,
    componentName: comp.displayName,
    spec,
    ref:
      spec.defaultRef === 'file' && spec.defaultFilePath
        ? { scheme: 'file', path: spec.defaultFilePath }
        : { scheme: 'env', name: spec.envVar },
  };
}

/** A whole spec.model for a provider switch: settings as given, secrets as references. */
function modelNode(model: NonNullable<SettingsPatch['model']>): Record<string, unknown> {
  const manifest = getModelProvider(model.provider ?? '');
  if (!manifest) throw new Error(`unknown model provider ${String(model.provider)}`);
  const node: Record<string, unknown> = { provider: manifest.id, name: model.name ?? '' };
  for (const field of manifest.configFields) {
    const value = model.config?.[field.key]?.trim();
    if (value) node[field.key] = value;
  }
  for (const secret of manifest.secrets) node[secret.key] = secretRefFor(secret);
  return node;
}

/** The paths a patch touches, for the audit log and the page. */
export function changedPaths(patch: SettingsPatch): string[] {
  const out: string[] = [];
  for (const [id, c] of Object.entries(patch.connectors ?? {})) {
    for (const key of ['enabled', 'access'] as const)
      if (c[key] !== undefined) out.push(`${id}.${key}`);
    for (const key of Object.keys(c.config ?? {})) out.push(`${id}.${key}`);
    if (c.allowBroadCredentials !== undefined) out.push(`${id}.allowBroadCredentials`);
  }
  if (patch.profile !== undefined) out.push('profile');
  if (patch.environments !== undefined) out.push('environments');
  for (const [section, values] of Object.entries({
    policy: patch.policy,
    model: patch.model,
    limits: patch.limits,
    console: patch.console,
    checks: patch.checks,
    monitoring: patch.monitoring,
    network: patch.network,
    dataProtection: patch.dataProtection,
    models: patch.models,
    ship: patch.ship,
    metrics: patch.metrics,
    tracing: patch.tracing,
    audit: patch.audit,
  })) {
    for (const key of Object.keys(values ?? {})) out.push(`${section}.${key}`);
  }
  return out;
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];

/**
 * Each entry with where it connects, like `orders (db.internal:3306 via bastion)`, so a
 * database pointed somewhere new counts as new access, not only a new name.
 */
function whereEntries(value: unknown): string[] {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return entriesOf(value).map((e) => {
    const port = text(e['port']) === '' ? '' : `:${text(e['port'])}`;
    const via = text(e['tunnelHost']) === '' ? '' : ` via ${text(e['tunnelHost'])}`;
    return `${text(e['name'])} (${text(e['host'])}${port}${via})`;
  });
}

/** Access the new config gives that the old one did not. */
export function moreAccess(before: AgentConfig, after: AgentConfig): AccessChange[] {
  const out: AccessChange[] = [];
  for (const [id, entry] of Object.entries(after.spec.connectors)) {
    if (!entry?.enabled) continue;
    const old = before.spec.connectors[id];
    if (!old?.enabled) {
      out.push({ code: 'enabled', connector: id });
      continue;
    }
    if (entry.access === 'read-write-approved' && old.access !== 'read-write-approved') {
      out.push({ code: 'write', connector: id });
    }
    for (const field of getConnector(id)?.configFields ?? []) {
      if (field.kind !== 'string-list' && field.kind !== 'entries') continue;
      const names = field.kind === 'entries' ? whereEntries : list;
      const was = new Set(names(old.config?.[field.key]));
      const added = names(entry.config?.[field.key]).filter((v) => !was.has(v));
      if (added.length > 0) out.push({ code: 'scope', connector: id, field: field.key, added });
    }
  }
  const approvers = new Set(before.spec.policy.approvals.approvers);
  for (const a of after.spec.policy.approvals.approvers) {
    if (!approvers.has(a)) out.push({ code: 'approver', approver: a });
  }
  if (
    after.spec.policy.destructiveActions === 'require-approval' &&
    before.spec.policy.destructiveActions !== 'require-approval'
  ) {
    out.push({ code: 'destructive' });
  }
  if (after.spec.console.chat && !before.spec.console.chat) out.push({ code: 'chat' });
  for (const [id, entry] of Object.entries(after.spec.connectors)) {
    if (entry?.allowBroadCredentials && !before.spec.connectors[id]?.allowBroadCredentials) {
      out.push({ code: 'broad', connector: id });
    }
  }
  // Less masking: data the model saw masked before now reaches it as is.
  const masked = (c: AgentConfig) =>
    new Set(c.spec.dataProtection.redact ?? defaultDetectors(c.spec.profile));
  const was = masked(before);
  const now = masked(after);
  const dropped = [...was].filter((d) => !now.has(d));
  if (dropped.length > 0) out.push({ code: 'unmasked', detectors: dropped });
  for (const name of Object.keys(after.spec.models)) {
    if (!(name in before.spec.models)) out.push({ code: 'named-model', name });
  }
  if (after.spec.tracing.enabled && after.spec.tracing.endpoint !== before.spec.tracing.endpoint) {
    out.push({ code: 'tracing', endpoint: after.spec.tracing.endpoint ?? '' });
  }
  if (modelDestination(after) !== modelDestination(before)) {
    out.push({ code: 'model', from: modelDestination(before), to: modelDestination(after) });
  }
  return out;
}

export interface SecretView {
  key: string;
  label: string;
  envVar: string;
  required: boolean;
  set: boolean;
  /** Whether the console can save it (file secrets too, M28). */
  writable: boolean;
  ref: string;
  description: string;
  howToCreate: string;
  /** A file (kubeconfig, SSH key): pasted or uploaded, then saved as a file. */
  format: SecretFormat | null;
  /** How to get it, with this connector's settings filled in. */
  steps: FilledStep[];
}

export interface ConnectorSettings {
  id: string;
  name: string;
  category: string;
  status: 'available' | 'coming-soon';
  description: string;
  accessLevels: AccessLevel[];
  summaries: Partial<Record<'always' | AccessLevel, string[] | undefined>>;
  enabled: boolean;
  access: AccessLevel | null;
  config: Record<string, unknown>;
  fields: ConfigField[];
  secrets: SecretView[];
  /** How to get a setting's value, by field key. */
  steps: Record<string, FilledStep[]>;
  /** The same for each entry's fields, by entry name ('' for an entry not saved yet). */
  entrySteps: Record<string, Record<string, FilledStep[]>>;
  /** Labels of the secrets this connector still needs. */
  missing: string[];
  /** For a connector whose credential's reach is checked (M29): whether a broad one is kept. */
  broadCredentials: boolean | null;
  tools: { read: number; write: number; destructive: number };
}

export interface SettingsView {
  target: 'compose' | 'kubernetes';
  editable: boolean;
  why: string | null;
  base: string;
  model: { provider: string; name: string };
  policy: { approvers: string[]; expiresAfterMinutes: number; destructiveActions: string };
  limits: AgentConfig['spec']['limits'];
  console: { chat: boolean };
  /** The extra CA certificates the agent trusts, and whether the console can change them. */
  network: {
    caBundleFile: string | null;
    caWritable: boolean;
    noProxy: string | null;
    /** Whether each proxy URL is set (the URLs are secrets, never shown). */
    proxy: { https: boolean; http: boolean };
    proxyWritable: boolean;
  };
  /** Everything else the config holds, for the console to change (M30b). */
  profile: string;
  rules: {
    minApprovers?: number | undefined;
    allowSelfApproval?: boolean | undefined;
    requireChangeRef?: boolean | undefined;
    changeRefPattern?: string | undefined;
  };
  environments: AgentConfig['spec']['environments'];
  checks: AgentConfig['spec']['checks'];
  monitoring: AgentConfig['spec']['monitoring'];
  dataProtection: {
    redact: string[] | null;
    /** What the profile masks when redact is unset. */
    defaults: string[];
    patterns: { name: string; regex: string }[];
  };
  models: {
    name: string;
    provider: string;
    model: string;
    config: Record<string, string>;
    secrets: { key: string; label: string; set: boolean }[];
  }[];
  ship: { baseImageMirrors: Record<string, string> };
  metrics: AgentConfig['spec']['metrics'];
  tracing: AgentConfig['spec']['tracing'];
  audit: { stdout: boolean };
  connectors: ConnectorSettings[];
  lastChange: { by: string; at: string; detail: string } | null;
  undoable: boolean;
}

/** A model provider the console can switch to (rendered from its manifest). */
export interface ProviderView {
  id: string;
  name: string;
  description: string;
  /** Where data goes, in the manifest's words. */
  sends: string[];
  fields: ConfigField[];
  secrets: {
    key: string;
    envVar: string;
    description: string;
    howToCreate: string;
    steps: FilledStep[];
    /** Already in .env (switching back needs no new key). */
    set: boolean;
  }[];
  config: Record<string, string>;
  writable: boolean;
}

export interface SettingsDeps {
  /** Where the settings live: files for Docker Compose, or the agent's own ConfigMap and Secret. */
  backend: ConfigBackend;
  audit: AuditLog;
  redactor: Redactor;
  /** The environment the agent started with (.env and the process). */
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  kubernetes: KubernetesFactory;
  probeTimeoutMs: number;
  now?: () => Date;
  /** Tests swap the model (MockLanguageModel) and the providers' public hosts. */
  createModel?: typeof createModel;
  endpoints?: ListContext['endpoints'];
  /** The agent's prompt size in tokens without a conversation, to check a model's window. */
  promptSize?: () => number;
  /** Tests swap how databases are reached (a password is tested before it is saved). */
  databases?: ProbeContext['databases'];
  /** Tests point Slack's users.list at a fake (M30b). */
  slackBase?: string;
}

/** Whether a proxy URL reference has a value. */
function proxySet(ref: string | undefined, env: Readonly<Record<string, string | undefined>>) {
  if (!ref) return false;
  const parsed = parseSecretRef(ref);
  return parsed.ok && parsed.ref.scheme === 'env' ? Boolean(env[parsed.ref.name]) : parsed.ok;
}

/** A model name as providers write them: letters, digits, and . _ - : / @. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

export class SettingsStore {
  private readonly deps: SettingsDeps;
  private readonly backend: ConfigBackend;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.backend = deps.backend;
  }

  async text(): Promise<string> {
    return this.backend.read();
  }

  /** Compose edits files; Kubernetes edits the agent's own ConfigMap, if the chart allows it. */
  private editable(config: AgentConfig): boolean {
    return (
      (config.spec.target === 'compose' && this.backend.where === 'files') ||
      (config.spec.target === 'kubernetes' && this.backend.where === 'kubernetes')
    );
  }

  /** Whether settings and secrets can be saved here (People needs both, for tokens). */
  async canEditSecrets(): Promise<boolean> {
    return this.editable(this.parse(await this.text())) && this.backend.envWritable;
  }

  private parse(text: string): AgentConfig {
    const parsed = parseAgentConfig(text);
    if (!parsed.ok) throw new Error(parsed.issues.map((i) => formatIssue(i)).join('\n'));
    return parsed.config;
  }

  async view(lastChange: SettingsView['lastChange']): Promise<SettingsView> {
    const text = await this.text();
    const config = this.parse(text);
    const editable = this.editable(config);
    const envWritable = editable && this.backend.envWritable;
    const comps = new Map(components(config).map((c) => [c.id, c]));
    const env = this.deps.env;
    const undoable = editable && (await this.backend.readPrevious()) !== null;
    // A file reference counts as set only when the file is there.
    const present = new Set<string>();
    for (const c of comps.values()) {
      for (const { ref } of c.secrets) {
        if (ref.scheme !== 'file') continue;
        const found = await access(ref.path).then(
          () => true,
          () => false,
        );
        if (found) present.add(ref.path);
      }
    }
    const isSet = (ref: SecretUse['ref'] | undefined) =>
      ref?.scheme === 'env' ? Boolean(env[ref.name]) : ref !== undefined && present.has(ref.path);
    const agentName = config.metadata.name;
    return {
      target: config.spec.target,
      editable,
      why: editable ? null : config.spec.target,
      base: hash(text),
      model: { provider: config.spec.model.provider, name: config.spec.model.name },
      policy: {
        approvers: config.spec.policy.approvals.approvers,
        expiresAfterMinutes: config.spec.policy.approvals.expiresAfterMinutes,
        destructiveActions: config.spec.policy.destructiveActions,
      },
      limits: config.spec.limits,
      console: { chat: config.spec.console.chat },
      network: {
        caBundleFile: config.spec.network.caBundleFile ?? null,
        caWritable: editable && this.backend.filesWritable,
        noProxy: config.spec.network.proxy?.noProxy ?? null,
        proxy: {
          https: proxySet(config.spec.network.proxy?.https, env),
          http: proxySet(config.spec.network.proxy?.http, env),
        },
        proxyWritable: envWritable,
      },
      profile: config.spec.profile,
      rules: {
        minApprovers: config.spec.policy.approvals.minApprovers,
        allowSelfApproval: config.spec.policy.approvals.allowSelfApproval,
        requireChangeRef: config.spec.policy.approvals.requireChangeRef,
        changeRefPattern: config.spec.policy.approvals.changeRefPattern,
      },
      environments: config.spec.environments,
      checks: config.spec.checks,
      monitoring: config.spec.monitoring,
      dataProtection: {
        redact: config.spec.dataProtection.redact ?? null,
        defaults: defaultDetectors(config.spec.profile),
        patterns: config.spec.dataProtection.patterns,
      },
      models: Object.entries(config.spec.models).map(([name, m]) => {
        const named = m as Record<string, unknown> & { provider: string; name: string };
        const manifest = getModelProvider(named.provider);
        const comp = comps.get(`model:${name}`);
        return {
          name,
          provider: named.provider,
          model: named.name,
          config: Object.fromEntries(
            (manifest?.configFields ?? []).flatMap((f) =>
              typeof named[f.key] === 'string' ? [[f.key, String(named[f.key])]] : [],
            ),
          ),
          secrets: (comp?.secrets ?? []).map((use) => ({
            key: use.spec.key,
            label: secretLabel(use),
            set: isSet(use.ref),
          })),
        };
      }),
      ship: { baseImageMirrors: config.spec.ship.baseImageMirrors },
      metrics: config.spec.metrics,
      tracing: config.spec.tracing,
      audit: { stdout: config.spec.audit.stdout },
      connectors: allConnectors.map((m) => {
        const entry = config.spec.connectors[m.id];
        const comp = comps.get(m.id);
        const risks = Object.values(m.tools);
        const settings = {
          ...defaults(m.configFields),
          ...(comp?.settings ?? entry?.config ?? {}),
          agentName,
        };
        const secrets: SecretView[] = [
          ...m.secrets.map((s) => {
            const use = comp?.secrets.find((u) => u.spec.key === s.key);
            const ref = use?.ref;
            const envName = ref?.scheme === 'env' ? ref.name : s.envVar;
            return {
              key: s.key,
              label: use ? secretLabel(use) : s.key,
              envVar: envName,
              required: isSecretRequired(s, config.spec.target),
              set: isSet(ref),
              writable: envWritable,
              ref: ref?.scheme === 'file' ? ref.path : `\${env:${envName}}`,
              description: s.description,
              howToCreate: s.howToCreate,
              format: s.format ?? null,
              steps: fillSteps(s.steps ?? [], settings),
            };
          }),
          // Each database's own secrets (an entry's password), named for it.
          ...(comp?.secrets ?? [])
            .filter((use) => !m.secrets.some((s) => s.key === use.spec.key))
            .map((use) => ({
              key: use.spec.key,
              label: secretLabel(use),
              envVar: use.ref.scheme === 'env' ? use.ref.name : use.spec.envVar,
              required: true,
              set: isSet(use.ref),
              writable: envWritable,
              ref: use.ref.scheme === 'file' ? use.ref.path : `\${env:${use.ref.name}}`,
              description: use.spec.description,
              howToCreate: use.spec.howToCreate,
              format: use.spec.format ?? null,
              steps: fillSteps(use.spec.steps ?? [], {
                ...entryValues(m, comp?.settings ?? {}, use.spec.key.split('.')[0] ?? ''),
                agentName,
              }),
            })),
        ];
        return {
          id: m.id,
          name: m.displayName,
          category: m.category,
          status: m.status,
          description: m.description,
          accessLevels: m.accessLevels,
          summaries: m.permissionsSummary,
          enabled: entry?.enabled === true,
          access: entry?.access ?? null,
          config: { ...(entry?.config ?? {}) },
          fields: m.configFields,
          secrets,
          steps: Object.fromEntries(
            m.configFields.flatMap((f) =>
              'steps' in f && f.steps ? [[f.key, fillSteps(f.steps, settings)]] : [],
            ),
          ),
          entrySteps: entrySteps(m, comp?.settings ?? {}, agentName),
          missing: entry?.enabled
            ? secrets.filter((s) => s.required && !s.set).map((s) => s.label)
            : [],
          broadCredentials: m.credentialScope ? entry?.allowBroadCredentials === true : null,
          tools: {
            read: risks.filter((r) => r === 'read').length,
            write: risks.filter((r) => r === 'write').length,
            destructive: risks.filter((r) => r === 'destructive').length,
          },
        };
      }),
      lastChange,
      undoable,
    };
  }

  async preview(input: SettingsPatch): Promise<Preview> {
    const text = await this.text();
    const before = this.parse(text);
    const base = hash(text);
    const { patch, problems } = await this.withSlackIds(input, before);
    if (problems.length > 0) {
      return {
        ok: false,
        errors: problems,
        diff: '',
        base,
        moreAccess: [],
        changed: [],
        policy: false,
      };
    }
    let next: string;
    try {
      next = patchConfigText(text, patch);
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
        diff: '',
        base,
        moreAccess: [],
        changed: [],
        policy: false,
      };
    }
    const parsed = parseAgentConfig(next);
    const errors = parsed.ok ? [] : parsed.issues.map((i) => formatIssue(i));
    if (parsed.ok && !parsed.config.spec.console.enabled) {
      errors.push('the console cannot turn itself off; change kodra-agent.yaml on the host');
    }
    if (
      parsed.ok &&
      before.spec.policy.approvals.approvers.some(isConsoleApprover) &&
      !parsed.config.spec.policy.approvals.approvers.some(isConsoleApprover)
    ) {
      errors.push('keep at least one console approver, or nobody could change settings here');
    }
    return {
      ok: errors.length === 0,
      errors,
      diff: unifiedDiff(text, next),
      base,
      moreAccess: parsed.ok ? moreAccess(before, parsed.config) : [],
      changed: changedPaths(patch),
      policy: parsed.ok && policyDiffers(before, parsed.config),
    };
  }

  /** Saves the patched file if nothing changed since the preview. The caller restarts the agent. */
  async apply(input: SettingsPatch, base: string, by: string): Promise<Preview | 'stale'> {
    const text = await this.text();
    if (hash(text) !== base) return 'stale';
    if (!this.editable(this.parse(text))) return this.refused(text);
    const { patch } = await this.withSlackIds(input, this.parse(text));
    const preview = await this.preview(patch);
    if (!preview.ok || preview.diff === '') return preview;
    await this.backend.save(patchConfigText(text, patch), text);
    await this.deps.audit.append({
      event: 'settings',
      actor: by,
      detail: `changed ${preview.changed.join(', ')}`.slice(0, 3_500),
    });
    return preview;
  }

  /**
   * Saves a patch made by the agent itself (People), checked like any other change but without
   * a preview first. The caller restarts the agent.
   */
  async applyNow(patch: SettingsPatch, by: string, detail: string): Promise<Preview> {
    const text = await this.text();
    if (!this.editable(this.parse(text))) return this.refused(text);
    const preview = await this.preview(patch);
    if (!preview.ok || preview.diff === '') return preview;
    await this.backend.save(patchConfigText(text, patch), text);
    await this.deps.audit.append({ event: 'settings', actor: by, detail });
    return preview;
  }

  async audit(by: string, detail: string): Promise<void> {
    await this.deps.audit.append({ event: 'settings', actor: by, detail });
  }

  /**
   * Slack approvers typed as @name, turned into user ids with the Slack connector's bot token
   * (users:read), as `init` does (M30b). Names that match nobody, or several people, are
   * problems for the preview.
   */
  private async withSlackIds(
    patch: SettingsPatch,
    config: AgentConfig,
  ): Promise<{ patch: SettingsPatch; problems: string[] }> {
    const lists = [
      patch.policy?.approvers ?? [],
      ...(patch.environments ?? []).map((e) =>
        Array.isArray(e['approvers']) ? e['approvers'].map(String) : [],
      ),
    ];
    // Names already in the config are left as they are (doctor flags them); only new ones.
    const known = new Set([
      ...config.spec.policy.approvals.approvers,
      ...config.spec.environments.flatMap((e) => e.approvers ?? []),
    ]);
    const names = approverNames(lists.flat()).filter((n) => !known.has(n));
    if (names.length === 0) return { patch, problems: [] };
    const slack = components(config).find((c) => c.id === 'slack');
    const { values } = slack
      ? await resolveAll(slack.secrets, { env: this.deps.env, redactor: this.deps.redactor })
      : { values: {} as Record<string, string> };
    const token = values['botToken'];
    if (!token) {
      return {
        patch,
        problems: [
          `${names.join(', ')}: Slack names need the Slack connector with its bot token, to look them up. Use console:<name> or a Slack user id (U…) instead.`,
        ],
      };
    }
    let users;
    try {
      users = await listSlackUsers(this.deps.fetch, token, this.deps.slackBase);
    } catch (error) {
      return {
        patch,
        problems: [
          `Cannot look up Slack names: ${this.deps.redactor.redact(error instanceof Error ? error.message : String(error))}. The bot token needs the users:read scope.`,
        ],
      };
    }
    const { found, problems } = matchNames(names, users);
    const swap = (list: string[]) => list.map((a) => found.get(a)?.id ?? a);
    return {
      patch: {
        ...patch,
        ...(patch.policy?.approvers
          ? { policy: { ...patch.policy, approvers: swap(patch.policy.approvers) } }
          : {}),
        ...(patch.environments
          ? {
              environments: patch.environments.map((e) =>
                Array.isArray(e['approvers'])
                  ? { ...e, approvers: swap(e['approvers'].map(String)) }
                  : e,
              ),
            }
          : {}),
      },
      problems,
    };
  }

  /**
   * Sets or removes the proxy URLs (M30b). They are secrets (a URL can hold a password), so
   * they go to .env or the agent's Secret, the config refers to them, and only their host is
   * audited. The caller restarts the agent, which applies them at startup.
   */
  async setProxy(
    urls: { https?: string | null; http?: string | null },
    by: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const text = await this.text();
    const config = this.parse(text);
    if (!this.editable(config) || !this.backend.envWritable) {
      return { ok: false, message: 'the proxy cannot be changed here' };
    }
    const doc = parseDocument(text);
    const set = new Map<string, string>();
    const remove: string[] = [];
    const notes: string[] = [];
    for (const kind of ['https', 'http'] as const) {
      const value = urls[kind];
      if (value === undefined) continue;
      const path = ['spec', 'network', 'proxy', kind];
      const current = config.spec.network.proxy?.[kind];
      const parsed = current ? parseSecretRef(current) : null;
      const envName =
        parsed?.ok && parsed.ref.scheme === 'env'
          ? parsed.ref.name
          : kind === 'https'
            ? 'KODRA_HTTPS_PROXY'
            : 'KODRA_HTTP_PROXY';
      if (value === null || value.trim() === '') {
        doc.deleteIn(path);
        remove.push(envName);
        notes.push(`removed the ${kind.toUpperCase()} proxy`);
        continue;
      }
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        return { ok: false, message: `the ${kind.toUpperCase()} proxy is not a URL` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, message: 'a proxy URL starts with http:// or https://' };
      }
      this.deps.redactor.add(value.trim());
      set.set(envName, value.trim());
      doc.setIn(path, `\${env:${envName}}`);
      notes.push(`set the ${kind.toUpperCase()} proxy (${url.host})`);
    }
    if (notes.length === 0) return { ok: false, message: 'no proxy to change' };
    const next = doc.toString();
    const parsed = parseAgentConfig(next);
    if (!parsed.ok) {
      return { ok: false, message: parsed.issues.map((i) => formatIssue(i)).join('; ') };
    }
    await this.backend.writeEnv(set, remove);
    if (next !== text) await this.backend.save(next, text);
    await this.deps.audit.append({ event: 'settings', actor: by, detail: notes.join('; ') });
    return { ok: true };
  }

  /** Sets and removes keys in .env (values are registered with the redactor first). */
  async writeEnv(set: ReadonlyMap<string, string>, remove: readonly string[] = []): Promise<void> {
    for (const value of set.values()) this.deps.redactor.add(value);
    await this.backend.writeEnv(set, remove);
  }

  private refused(text: string): Preview {
    return {
      ok: false,
      errors: ['settings cannot be changed here'],
      diff: '',
      base: hash(text),
      moreAccess: [],
      changed: [],
      policy: false,
    };
  }

  /** What Undo would put back: its diff, and whether that is a policy change. Null: nothing. */
  async undoPreview(): Promise<{ diff: string; policy: boolean } | null> {
    const current = await this.text();
    const previous = await this.backend.readPrevious();
    if (previous === null) return null;
    return {
      diff: unifiedDiff(current, previous),
      policy: policyDiffers(this.parse(current), this.parse(previous)),
    };
  }

  /** Puts the previous file back (and keeps the current one, so Undo can be undone). */
  async undo(by: string): Promise<boolean> {
    const current = await this.text();
    if (!this.editable(this.parse(current))) return false;
    const previous = await this.backend.readPrevious();
    if (previous === null) return false;
    this.parse(previous);
    await this.backend.save(previous, current);
    await this.deps.audit.append({ event: 'settings', actor: by, detail: 'undid the last change' });
    return true;
  }

  /**
   * Checks a new secret value with the connector's probe, then saves it: a file secret (a
   * kubeconfig, an SSH key) as an owner-only file in the bundle's secrets folder on Docker
   * Compose, anything else in .env (or the agent's Secret). The config is pointed at where it
   * went, if it pointed elsewhere or nowhere. The value is registered with the redactor first
   * and never returned. The caller restarts the agent.
   */
  async setSecret(connector: string, key: string, value: string, by: string): Promise<ProbeResult> {
    const config = this.parse(await this.text());
    if (!this.editable(config) || !this.backend.envWritable) {
      return { status: 'fail', message: 'secrets cannot be changed here' };
    }
    const comp = components(config).find((c) => c.id === connector);
    if (!comp) return { status: 'fail', message: 'turn this connector on first' };
    const use = comp.secrets.find((s) => s.spec.key === key) ?? unreferenced(comp, key);
    if (!use) return { status: 'fail', message: 'this connector has no such secret' };
    const format = use.spec.format;
    const candidate = format ? `${value.replace(/\r\n/g, '\n').trim()}\n` : value.trim();
    if (candidate.trim().length < 4) return { status: 'fail', message: 'that value is too short' };
    this.deps.redactor.add(candidate);
    if (format) for (const part of secretParts(format, candidate)) this.deps.redactor.add(part);
    if (!format && candidate.includes('\n')) {
      return { status: 'fail', message: 'that value has more than one line' };
    }
    const problem = format ? secretShapeProblem(format, candidate) : null;
    if (problem) return { status: 'fail', message: problem };
    const { values } = await resolveAll(comp.secrets, {
      env: this.deps.env,
      redactor: this.deps.redactor,
    });
    const result = await runProbe(use.spec.probe, {
      component: comp,
      secrets: { ...values, [key]: candidate },
      fetch: this.deps.fetch,
      kubernetes: this.deps.kubernetes,
      timeoutMs: this.deps.probeTimeoutMs,
      only: key,
      ...(this.deps.databases ? { databases: this.deps.databases } : {}),
    });
    if (result.status === 'fail') {
      return format === 'kubeconfig' && usesAwsExec(candidate)
        ? {
            ...result,
            hint: 'This kubeconfig signs in with aws eks get-token: save the AWS keys below first, or make a kubeconfig for a service account with the steps above.',
          }
        : result;
    }
    let ref: string;
    if (format && this.backend.filesWritable) {
      const path = await this.backend.writeSecretFile(secretFileName(connector, key), candidate);
      ref = `\${file:${path}}`;
    } else {
      const name = use.ref.scheme === 'env' ? use.ref.name : use.spec.envVar;
      await this.backend.writeEnv(new Map([[name, candidate]]), []);
      ref = `\${env:${name}}`;
    }
    const text = await this.text();
    const next = setSecretRef(text, comp.manifest, key, ref);
    if (next !== text) {
      const parsed = parseAgentConfig(next);
      if (!parsed.ok) {
        return { status: 'fail', message: parsed.issues.map((i) => formatIssue(i)).join('; ') };
      }
      await this.backend.save(next, text);
    }
    await this.deps.audit.append({
      event: 'settings',
      actor: by,
      connector,
      detail: `replaced ${use.componentName} ${key} (${ref.startsWith('${env:') ? ref.slice(6, -1) : `file ${ref.slice(7, -1)}`})`,
    });
    return result;
  }

  /**
   * Saves the extra CA certificates the agent trusts (an internal CA, Amazon RDS) and points
   * spec.network.caBundleFile at them; null stops trusting them. Docker Compose only: on
   * Kubernetes they come from the chart's caBundle. The caller restarts the agent, which
   * applies them at startup.
   */
  async setCaBundle(
    pem: string | null,
    by: string,
  ): Promise<{ ok: true; certificates: number } | { ok: false; message: string }> {
    const text = await this.text();
    if (!this.editable(this.parse(text)) || !this.backend.filesWritable) {
      return { ok: false, message: 'trusted certificates cannot be changed here' };
    }
    const doc = parseDocument(text);
    const at = ['spec', 'network', 'caBundleFile'];
    let certificates = 0;
    let detail: string;
    if (pem === null) {
      if (!doc.hasIn(at)) return { ok: false, message: 'no extra certificates are trusted' };
      doc.deleteIn(at);
      detail = 'stopped trusting the extra CA certificates';
    } else {
      const candidate = `${pem.replace(/\r\n/g, '\n').trim()}\n`;
      const checked = caCertificates(candidate);
      if ('problem' in checked) return { ok: false, message: checked.problem };
      certificates = checked.count;
      const path = await this.backend.writeCaFile(candidate);
      doc.setIn(at, path);
      detail = `trusts ${String(certificates)} CA certificates (file ${path})`;
    }
    const next = doc.toString();
    const parsed = parseAgentConfig(next);
    if (!parsed.ok) {
      return { ok: false, message: parsed.issues.map((i) => formatIssue(i)).join('; ') };
    }
    if (next !== text) await this.backend.save(next, text);
    await this.deps.audit.append({ event: 'settings', actor: by, detail });
    return { ok: true, certificates };
  }

  /** The model provider's component, with the secrets the agent started with. */
  private async modelComponent() {
    const config = this.parse(await this.text());
    const comp = components(config).find((c) => c.manifest.category === 'model');
    if (!comp) throw new Error('no model provider');
    const { values } = await resolveAll(comp.secrets, {
      env: this.deps.env,
      redactor: this.deps.redactor,
    });
    return { config, comp, secrets: values };
  }

  /**
   * The picker: models the key can use, with list prices and this month's usage priced at
   * each. The provider's list is read with the agent's own key, which never leaves here.
   */
  async modelOptions(records: readonly AuditRecord[]): Promise<ModelOptionsView> {
    const { config, comp, secrets } = await this.modelComponent();
    const listed = await listProviderModels(comp, secrets, {
      fetch: this.deps.fetch,
      timeoutMs: this.deps.probeTimeoutMs,
      ...(this.deps.endpoints ? { endpoints: this.deps.endpoints } : {}),
    });
    const current = config.spec.model.name;
    const prices = { ...(comp.manifest.pricing?.models ?? {}) };
    // The config's price override is for the model it runs.
    if (config.spec.console.pricing) prices[current] = config.spec.console.pricing;
    const view = modelOptions({
      provider: comp.id,
      current,
      prices,
      listed:
        listed && 'error' in listed ? { error: this.deps.redactor.redact(listed.error) } : listed,
      records,
      month: (this.deps.now?.() ?? new Date()).toISOString().slice(0, 7),
    });
    return view;
  }

  /** One tiny call to `name` with the current provider and key, before it is saved. */
  async testModel(
    name: string,
  ): Promise<{ ok: true; contextWarning?: ContextWarning } | { ok: false; error: string }> {
    if (!MODEL_NAME.test(name)) return { ok: false, error: 'that is not a model name' };
    const { config, secrets } = await this.modelComponent();
    let model;
    try {
      model = (this.deps.createModel ?? createModel)({ ...config.spec.model, name }, secrets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: this.deps.redactor.redact(message) };
    }
    const result = await testModel(model, this.deps.redactor);
    if (!result.ok) return result;
    // The test call loaded the model, so Ollama can say which window it runs it with.
    const warning = await this.contextWarning({ ...config.spec.model, name });
    return warning ? { ok: true, contextWarning: warning } : { ok: true };
  }

  /**
   * A model whose context window is smaller than the agent's prompt (Ollama, once the model is
   * loaded), or null when it fits or cannot be known.
   */
  async contextWarning(model: AgentConfig['spec']['model']): Promise<ContextWarning | null> {
    if (model.provider !== 'ollama' || !this.deps.promptSize) return null;
    const needed = this.deps.promptSize();
    const { loaded } = await ollamaContext(model.baseUrl, model.name, this.deps.fetch);
    return loaded !== null && needed > loaded
      ? { model: model.name, needed, window: loaded }
      : null;
  }

  /** A new model name in a patch must answer first; null when there is none or it did. */
  async checkModelChange(patch: SettingsPatch): Promise<string | null> {
    const name = patch.model?.name;
    // A provider switch is checked as a whole (switchCandidate), with the new key.
    if (name === undefined || patch.model?.provider !== undefined) return null;
    const { config } = await this.modelComponent();
    if (name === config.spec.model.name) return null;
    const result = await this.testModel(name);
    return result.ok ? null : `${name} did not answer: ${result.error}`;
  }

  /** The model providers the console can switch to, and whether each one's key is in .env. */
  async providers(): Promise<ProviderView[]> {
    const config = this.parse(await this.text());
    const writable = this.editable(config) && this.backend.envWritable;
    return modelProviders.map((m) => ({
      id: m.id,
      name: m.displayName,
      description: m.description,
      sends: m.permissionsSummary.always ?? [],
      fields: m.configFields,
      secrets: m.secrets.map((s) => ({
        key: s.key,
        envVar: s.envVar,
        description: s.description,
        howToCreate: s.howToCreate,
        steps: fillSteps(s.steps ?? [], {}),
        set: Boolean(this.deps.env[s.envVar]),
      })),
      // The current settings, so switching back starts from them.
      config:
        config.spec.model.provider === m.id
          ? Object.fromEntries(
              m.configFields.flatMap((f): [string, string][] => {
                const v = (config.spec.model as Record<string, unknown>)[f.key];
                return typeof v === 'string' ? [[f.key, v]] : [];
              }),
            )
          : {},
      writable,
    }));
  }

  /**
   * A provider switch, checked before anything is written: the new config parses, the
   * provider's checks pass with the new key (or the one already in .env), and its model list
   * is read. Typed secret values are registered with the redactor and only returned in `env`.
   */
  async switchCandidate(c: {
    provider: string;
    name: string;
    config: Record<string, string>;
    secrets: Record<string, string>;
  }): Promise<
    | { ok: false; error: string; checks?: { check: string; status: string; message: string }[] }
    | {
        ok: true;
        patch: SettingsPatch;
        env: Map<string, string>;
        model: AgentConfig['spec']['model'];
        secrets: Readonly<Record<string, string>>;
        checks: { check: string; status: string; message: string }[];
        listed: Awaited<ReturnType<typeof listProviderModels>>;
      }
  > {
    const manifest = getModelProvider(c.provider);
    if (!manifest) return { ok: false, error: 'unknown model provider' };
    const text = await this.text();
    const before = this.parse(text);
    if (!this.editable(before)) return { ok: false, error: 'settings cannot be changed here' };
    const env = new Map<string, string>();
    for (const s of manifest.secrets) {
      const typed = c.secrets[s.key]?.trim() ?? '';
      if (typed !== '') {
        if (typed.length < 4) return { ok: false, error: `${s.envVar}: that value is too short` };
        this.deps.redactor.add(typed);
        env.set(s.envVar, typed);
      } else if (s.required && !this.deps.env[s.envVar]) {
        return { ok: false, error: `${s.envVar} is needed` };
      }
    }
    if (env.size > 0 && !this.backend.envWritable) {
      return { ok: false, error: 'secrets cannot be changed here' };
    }
    const name = c.name.trim() || Object.keys(manifest.pricing?.models ?? {})[0] || 'model';
    if (!MODEL_NAME.test(name)) return { ok: false, error: 'that is not a model name' };
    const patch: SettingsPatch = { model: { provider: manifest.id, name, config: c.config } };
    let next: AgentConfig;
    try {
      const parsed = parseAgentConfig(patchConfigText(text, patch));
      if (!parsed.ok) {
        return { ok: false, error: parsed.issues.map((i) => formatIssue(i)).join('; ') };
      }
      next = parsed.config;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const comp = components(next).find((x) => x.manifest.category === 'model');
    if (!comp) return { ok: false, error: 'no model provider' };
    const { values } = await resolveAll(comp.secrets, {
      env: { ...this.deps.env, ...Object.fromEntries(env) },
      redactor: this.deps.redactor,
    });
    const checks: { check: string; status: string; message: string }[] = [];
    for (const id of probeIds(comp)) {
      const r = await runProbe(id, {
        component: comp,
        secrets: values,
        fetch: this.deps.fetch,
        kubernetes: this.deps.kubernetes,
        timeoutMs: this.deps.probeTimeoutMs,
        ...(this.deps.endpoints ? { endpoints: this.deps.endpoints } : {}),
      });
      checks.push({ check: id, status: r.status, message: this.deps.redactor.redact(r.message) });
    }
    if (checks.some((x) => x.status === 'fail')) {
      return { ok: false, error: 'the provider check failed', checks };
    }
    const listed = await listProviderModels(comp, values, {
      fetch: this.deps.fetch,
      timeoutMs: this.deps.probeTimeoutMs,
      ...(this.deps.endpoints ? { endpoints: this.deps.endpoints } : {}),
    });
    return { ok: true, patch, env, model: next.spec.model, secrets: values, checks, listed };
  }

  /** The candidate's model answers one tiny question, with the candidate's key. */
  async testCandidate(
    model: AgentConfig['spec']['model'],
    secrets: Readonly<Record<string, string>>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      return await testModel(
        (this.deps.createModel ?? createModel)(model, secrets),
        this.deps.redactor,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: this.deps.redactor.redact(message) };
    }
  }

  /** The connector's checks, as `doctor` runs them, with the secrets the agent started with. */
  async test(connector: string): Promise<{ check: string; status: string; message: string }[]> {
    const config = this.parse(await this.text());
    const comp = components(config).find((c) => c.id === connector);
    if (!comp) return [{ check: connector, status: 'fail', message: 'not enabled' }];
    const { values, missing } = await resolveAll(comp.secrets, {
      env: this.deps.env,
      redactor: this.deps.redactor,
    });
    const rows = missing.map((m) => ({
      check: secretLabel(m.use),
      status: 'fail',
      message: m.reason,
    }));
    for (const id of probeIds(comp)) {
      const r = await runProbe(id, {
        component: comp,
        secrets: values,
        fetch: this.deps.fetch,
        kubernetes: this.deps.kubernetes,
        timeoutMs: this.deps.probeTimeoutMs,
      });
      rows.push({ check: id, status: r.status, message: this.deps.redactor.redact(r.message) });
    }
    return rows;
  }
}
