import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getConnector, getModelProvider, parseAgentConfig } from '@kodra-agent/connectors';
import {
  entriesOf,
  entryEnvVar,
  formatIssue,
  parseSecretRef,
  type AgentConfig,
  type Manifest,
  type SecretRef,
  type SecretSpec,
} from '@kodra-agent/schema';

export const DEFAULT_CONFIG_FILE = 'kodra-agent.yaml';

export function configPath(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(flag ?? env['KODRA_AGENT_CONFIG'] ?? DEFAULT_CONFIG_FILE);
}

export type LoadResult =
  | { ok: true; config: AgentConfig; path: string; dir: string }
  | { ok: false; path: string; errors: string[] };

export async function loadConfig(path: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {
      ok: false,
      path,
      errors: [`Cannot read ${path}. Pass --config or set KODRA_AGENT_CONFIG.`],
    };
  }
  const result = parseAgentConfig(text);
  if (!result.ok) {
    return { ok: false, path, errors: result.issues.map((i) => formatIssue(i, path)) };
  }
  return { ok: true, config: result.config, path, dir: dirname(path) };
}

/** The model provider or a connector, as one thing to check. */
export interface Component {
  id: string;
  displayName: string;
  manifest: Manifest;
  /** Model fields or the connector's `config`, after defaults. */
  settings: Record<string, unknown>;
  secrets: SecretUse[];
  /** For a named model (spec.models), its name (M13). */
  named?: string;
}

export interface SecretUse {
  component: string;
  componentName: string;
  spec: SecretSpec;
  ref: SecretRef;
}

/** The model and every enabled connector, with the secrets their config refers to. */
export function components(config: AgentConfig): Component[] {
  const out: Component[] = [];
  const model = config.spec.model as Record<string, unknown> & { provider: string };
  const provider = getModelProvider(model.provider);
  if (provider) out.push(component(provider, model, model));

  for (const [id, entry] of Object.entries(config.spec.connectors)) {
    if (!entry?.enabled) continue;
    const manifest = getConnector(id);
    if (!manifest) continue;
    out.push(component(manifest, entry.config ?? {}, entry.secrets ?? {}));
  }
  // Named models, for environments that pin one (M13): their keys are checked like any other.
  for (const [name, named] of Object.entries(config.spec.models)) {
    const m = named as Record<string, unknown> & { provider: string };
    const manifest = getModelProvider(m.provider);
    if (!manifest) continue;
    const comp = component(manifest, m, m);
    const displayName = `${manifest.displayName} (model ${name})`;
    out.push({
      ...comp,
      id: `model:${name}`,
      displayName,
      named: name,
      secrets: comp.secrets.map((s) => ({
        ...s,
        component: `model:${name}`,
        componentName: displayName,
      })),
    });
  }
  return out;
}

function component(
  manifest: Manifest,
  settings: Record<string, unknown>,
  refs: Record<string, unknown>,
): Component {
  const secrets: SecretUse[] = [];
  for (const spec of manifest.secrets) {
    const raw = refs[spec.key];
    if (typeof raw !== 'string') continue;
    const parsed = parseSecretRef(raw);
    if (parsed.ok) {
      secrets.push({
        component: manifest.id,
        componentName: manifest.displayName,
        spec,
        ref: parsed.ref,
      });
    }
  }
  secrets.push(...entrySecrets(manifest, settings));
  return { id: manifest.id, displayName: manifest.displayName, manifest, settings, secrets };
}

/**
 * The secrets of `entries` settings (a database's password), keyed `<entry>.<field>`, like
 * `orders.password`. They are optional to the connector: an entry whose secret is missing
 * reports it, and the others keep working. Their check is the connector's health probe.
 */
function entrySecrets(manifest: Manifest, settings: Record<string, unknown>): SecretUse[] {
  const out: SecretUse[] = [];
  for (const field of manifest.configFields) {
    if (field.kind !== 'entries') continue;
    for (const entry of entriesOf(settings[field.key])) {
      const name = String(entry['name']);
      for (const f of field.fields) {
        if (f.kind !== 'secret') continue;
        const raw = entry[f.key];
        const parsed = typeof raw === 'string' ? parseSecretRef(raw) : null;
        if (!parsed?.ok) continue;
        out.push({
          component: manifest.id,
          componentName: manifest.displayName,
          spec: {
            key: `${name}.${f.key}`,
            envVar: entryEnvVar(field, name, f.envVar),
            defaultRef: 'env',
            required: false,
            description: f.description,
            howToCreate: f.howToCreate,
            minimumScopes: {},
            probe: manifest.healthProbe ?? `${manifest.id}.connect`,
            ...(f.format ? { format: f.format } : {}),
            ...(f.steps ? { steps: f.steps } : {}),
          },
          ref: parsed.ref,
        });
      }
    }
  }
  return out;
}

/** A short, value-free label for a secret, like "GitHub token (GITHUB_TOKEN)". */
export function secretLabel(use: SecretUse): string {
  const where = use.ref.scheme === 'env' ? use.ref.name : `file ${use.ref.path}`;
  return `${use.componentName} ${use.spec.key} (${where})`;
}
