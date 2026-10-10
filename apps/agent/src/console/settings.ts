import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  connectors as allConnectors,
  getConnector,
  parseAgentConfig,
} from '@kodra-agent/connectors';
import {
  formatIssue,
  isConsoleApprover,
  type AccessLevel,
  type AgentConfig,
  type ConfigField,
  type LocalizedText,
} from '@kodra-agent/schema';
import { secretRefFor } from '@kodra-agent/templates';
import { parseDocument } from 'yaml';
import type { AuditLog } from '../audit.ts';
import { ENV_HEADER } from '../commands/init.ts';
import { components, secretLabel } from '../config.ts';
import { unifiedDiff } from '../diff.ts';
import { renderEnvFile, writePrivateFile } from '../env-file.ts';
import type { KubernetesFactory } from '../kubernetes.ts';
import { probeIds, runProbe, type ProbeResult } from '../probes.ts';
import type { Redactor } from '../redactor.ts';
import { resolveAll } from '../secrets.ts';

/**
 * Settings from the console (M8c): an approver edits kodra-agent.yaml through a patch that
 * keeps the file's comments, sees the diff and any access it adds, and saves; the agent keeps
 * the previous file (Undo puts it back), audits the change, and restarts to apply it.
 * Secrets are write-only: checked first, then written to .env. Docker Compose only for now;
 * on Kubernetes the config is a ConfigMap the agent cannot change yet.
 */

export interface ConnectorPatch {
  enabled?: boolean;
  access?: AccessLevel;
  /** Setting values by key; null removes a setting. */
  config?: Record<string, unknown>;
}

export interface SettingsPatch {
  connectors?: Record<string, ConnectorPatch>;
  policy?: {
    approvers?: string[];
    expiresAfterMinutes?: number;
    destructiveActions?: 'deny' | 'require-approval';
  };
  model?: { name?: string };
  limits?: {
    maxSteps?: number;
    tokenBudget?: number;
    timeoutMinutes?: number;
    /** null removes the budget. */
    monthlyBudgetUsd?: number | null;
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
  | { code: 'chat' };

export interface Preview {
  ok: boolean;
  errors: string[];
  diff: string;
  base: string;
  moreAccess: AccessChange[];
  changed: string[];
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

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
    for (const [key, value] of Object.entries(c.config ?? {})) {
      set([...base, 'config', key], value);
    }
  }
  set(['spec', 'policy', 'approvals', 'approvers'], patch.policy?.approvers);
  set(['spec', 'policy', 'approvals', 'expiresAfterMinutes'], patch.policy?.expiresAfterMinutes);
  set(['spec', 'policy', 'destructiveActions'], patch.policy?.destructiveActions);
  set(['spec', 'model', 'name'], patch.model?.name);
  for (const key of ['maxSteps', 'tokenBudget', 'timeoutMinutes', 'monthlyBudgetUsd'] as const) {
    set(['spec', 'limits', key], patch.limits?.[key]);
  }
  set(['spec', 'console', 'chat'], patch.console?.chat);
  return doc.toString();
}

/** The paths a patch touches, for the audit log and the page. */
export function changedPaths(patch: SettingsPatch): string[] {
  const out: string[] = [];
  for (const [id, c] of Object.entries(patch.connectors ?? {})) {
    for (const key of ['enabled', 'access'] as const)
      if (c[key] !== undefined) out.push(`${id}.${key}`);
    for (const key of Object.keys(c.config ?? {})) out.push(`${id}.${key}`);
  }
  for (const [section, values] of Object.entries({
    policy: patch.policy,
    model: patch.model,
    limits: patch.limits,
    console: patch.console,
  })) {
    for (const key of Object.keys(values ?? {})) out.push(`${section}.${key}`);
  }
  return out;
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];

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
      if (field.kind !== 'string-list') continue;
      const was = new Set(list(old.config?.[field.key]));
      const added = list(entry.config?.[field.key]).filter((v) => !was.has(v));
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
  return out;
}

export interface SecretView {
  key: string;
  label: string;
  envVar: string;
  required: boolean;
  set: boolean;
  /** An ${env:...} secret the console can replace; file secrets live on a read-only mount. */
  writable: boolean;
  ref: string;
  description: LocalizedText;
  howToCreate: LocalizedText;
}

export interface ConnectorSettings {
  id: string;
  name: string;
  category: string;
  status: 'available' | 'coming-soon';
  description: LocalizedText;
  accessLevels: AccessLevel[];
  summaries: Partial<Record<'always' | AccessLevel, LocalizedText[] | undefined>>;
  enabled: boolean;
  access: AccessLevel | null;
  config: Record<string, unknown>;
  fields: ConfigField[];
  secrets: SecretView[];
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
  connectors: ConnectorSettings[];
  lastChange: { by: string; at: string; detail: string } | null;
  undoable: boolean;
}

export interface SettingsDeps {
  configPath: string;
  audit: AuditLog;
  redactor: Redactor;
  /** The environment the agent started with (.env and the process). */
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  kubernetes: KubernetesFactory;
  probeTimeoutMs: number;
  now?: () => Date;
}

export class SettingsStore {
  private readonly deps: SettingsDeps;
  private readonly backupPath: string;
  private readonly envPath: string;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.backupPath = `${deps.configPath}.previous`;
    this.envPath = join(dirname(deps.configPath), '.env');
  }

  async text(): Promise<string> {
    return readFile(this.deps.configPath, 'utf8');
  }

  private parse(text: string): AgentConfig {
    const parsed = parseAgentConfig(text);
    if (!parsed.ok) throw new Error(parsed.issues.map((i) => formatIssue(i)).join('\n'));
    return parsed.config;
  }

  async view(lastChange: SettingsView['lastChange']): Promise<SettingsView> {
    const text = await this.text();
    const config = this.parse(text);
    const compose = config.spec.target === 'compose';
    const comps = new Map(components(config).map((c) => [c.id, c]));
    const env = this.deps.env;
    const undoable = await readFile(this.backupPath, 'utf8')
      .then(() => true)
      .catch(() => false);
    return {
      target: config.spec.target,
      editable: compose,
      why: compose ? null : 'kubernetes',
      base: hash(text),
      model: { provider: config.spec.model.provider, name: config.spec.model.name },
      policy: {
        approvers: config.spec.policy.approvals.approvers,
        expiresAfterMinutes: config.spec.policy.approvals.expiresAfterMinutes,
        destructiveActions: config.spec.policy.destructiveActions,
      },
      limits: config.spec.limits,
      console: { chat: config.spec.console.chat },
      connectors: allConnectors.map((m) => {
        const entry = config.spec.connectors[m.id];
        const comp = comps.get(m.id);
        const risks = Object.values(m.tools);
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
          secrets: m.secrets.map((s) => {
            const use = comp?.secrets.find((u) => u.spec.key === s.key);
            const ref = use?.ref;
            const envName = ref?.scheme === 'env' ? ref.name : s.envVar;
            return {
              key: s.key,
              label: use ? secretLabel(use) : s.key,
              envVar: envName,
              required: s.required,
              set: ref?.scheme === 'env' ? Boolean(env[ref.name]) : ref !== undefined,
              writable:
                compose && (ref === undefined ? s.defaultRef === 'env' : ref.scheme === 'env'),
              ref: ref?.scheme === 'file' ? ref.path : `\${env:${envName}}`,
              description: s.description,
              howToCreate: s.howToCreate,
            };
          }),
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

  async preview(patch: SettingsPatch): Promise<Preview> {
    const text = await this.text();
    const before = this.parse(text);
    const base = hash(text);
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
    };
  }

  /** Saves the patched file if nothing changed since the preview. The caller restarts the agent. */
  async apply(patch: SettingsPatch, base: string, by: string): Promise<Preview | 'stale'> {
    const text = await this.text();
    if (hash(text) !== base) return 'stale';
    const preview = await this.preview(patch);
    if (!preview.ok || preview.diff === '') return preview;
    await writeFile(this.backupPath, text, 'utf8');
    await this.writeConfig(patchConfigText(text, patch));
    await this.deps.audit.append({
      event: 'settings',
      actor: by,
      detail: `changed ${preview.changed.join(', ')}`.slice(0, 3_500),
    });
    return preview;
  }

  /** Puts the previous file back (and keeps the current one, so Undo can be undone). */
  async undo(by: string): Promise<boolean> {
    const previous = await readFile(this.backupPath, 'utf8').catch(() => null);
    if (previous === null) return false;
    const current = await this.text();
    this.parse(previous);
    await writeFile(this.backupPath, current, 'utf8');
    await this.writeConfig(previous);
    await this.deps.audit.append({ event: 'settings', actor: by, detail: 'undid the last change' });
    return true;
  }

  /**
   * Checks a new secret value with the connector's probe, then writes it to .env. The value is
   * registered with the redactor first and never returned. The caller restarts the agent.
   */
  async setSecret(connector: string, key: string, value: string, by: string): Promise<ProbeResult> {
    const trimmed = value.trim();
    if (trimmed.length < 4) return { status: 'fail', message: 'that value is too short' };
    this.deps.redactor.add(trimmed);
    const config = this.parse(await this.text());
    if (config.spec.target !== 'compose') {
      return { status: 'fail', message: "on Kubernetes, secrets live in the agent's Secret" };
    }
    const comp = components(config).find((c) => c.id === connector);
    const use = comp?.secrets.find((s) => s.spec.key === key);
    if (!comp || !use) return { status: 'fail', message: 'this connector has no such secret' };
    if (use.ref.scheme !== 'env') {
      return { status: 'fail', message: `put the file at ${use.ref.path} on the host instead` };
    }
    const { values } = await resolveAll(comp.secrets, {
      env: this.deps.env,
      redactor: this.deps.redactor,
    });
    const result = await runProbe(use.spec.probe, {
      component: comp,
      secrets: { ...values, [key]: trimmed },
      fetch: this.deps.fetch,
      kubernetes: this.deps.kubernetes,
      timeoutMs: this.deps.probeTimeoutMs,
    });
    if (result.status === 'fail') return result;
    const existing = await readFile(this.envPath, 'utf8').catch(() => null);
    await writePrivateFile(
      this.envPath,
      renderEnvFile(existing, new Map([[use.ref.name, trimmed]]), ENV_HEADER),
    );
    await this.deps.audit.append({
      event: 'settings',
      actor: by,
      connector,
      detail: `replaced ${secretLabel(use)}`,
    });
    return result;
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

  private async writeConfig(text: string): Promise<void> {
    const temp = `${this.deps.configPath}.${String(process.pid)}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, this.deps.configPath);
  }
}
