import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getConnector, getModelProvider, parseAgentConfig } from '@kodra-agent/connectors';
import {
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
  return { id: manifest.id, displayName: manifest.displayName, manifest, settings, secrets };
}

/** A short, value-free label for a secret, like "GitHub token (GITHUB_TOKEN)". */
export function secretLabel(use: SecretUse): string {
  const where = use.ref.scheme === 'env' ? use.ref.name : `file ${use.ref.path}`;
  return `${use.componentName} ${use.spec.key} (${where})`;
}
