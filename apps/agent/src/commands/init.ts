import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isSecretRequired, type AgentConfig } from '@kodra-agent/schema';
import { stringify } from 'yaml';
import { components, loadConfig, secretLabel, type Component, type SecretUse } from '../config.ts';
import { CONSOLE_TOKEN_ENV, newConsoleToken } from '../console/token.ts';
import { AGENT_NAMESPACE, type Context } from '../context.ts';
import { parseEnvFile, renderEnvFile, writePrivateFile } from '../env-file.ts';
import { runProbe, type ProbeResult } from '../probes.ts';

export interface InitOptions {
  configPath: string;
  target?: 'compose' | 'kubernetes' | undefined;
  namespace?: string | undefined;
  nonInteractive: boolean;
  dryRun: boolean;
}

type Collected = Map<SecretUse, string>;

class Abort extends Error {}

const ENV_HEADER = [
  '# Written by `kodra-agent init`. Owner-only permissions (0600).',
  '# Never commit this file.',
].join('\n');

export async function init(opts: InitOptions, ctx: Context): Promise<number> {
  const loaded = await loadConfig(opts.configPath);
  if (!loaded.ok) {
    for (const e of loaded.errors) ctx.term.err(e);
    return 1;
  }
  const { config, dir } = loaded;
  const target = opts.target ?? config.spec.target;
  const comps = components(config);
  const uses = comps.flatMap((c) => c.secrets);

  if (target === 'kubernetes' && opts.dryRun) {
    ctx.term.out(dryRunManifest(config, uses, opts.namespace ?? AGENT_NAMESPACE));
    return 0;
  }
  // With the console on, there is always one value to store: its sign-in token.
  if (uses.length === 0 && !config.spec.console.enabled) {
    ctx.term.out('This configuration needs no secrets. Nothing to do.');
    return 0;
  }
  if (uses.length > 0 && !opts.nonInteractive && !ctx.prompter) {
    ctx.term.err(
      'No terminal to ask questions on. Run with --non-interactive to read values from the environment.',
    );
    return 1;
  }

  const envPath = join(dir, '.env');
  const existingText = target === 'compose' ? await readOptional(envPath) : null;
  const existing = existingText === null ? new Map<string, string>() : parseEnvFile(existingText);
  for (const value of existing.values()) ctx.redactor.add(value);

  if (uses.length > 0) {
    ctx.term.out(
      `Setting up ${String(uses.length)} secret${uses.length === 1 ? '' : 's'} for ${config.metadata.name} (${target}).`,
    );
    ctx.term.out('Values are hidden as you type and are never shown again.');
  }

  const collected: Collected = new Map();
  const failures: string[] = [];
  try {
    for (const comp of comps) {
      for (const use of comp.secrets) {
        const outcome = opts.nonInteractive
          ? await fromEnvironment(use, comp, collected, existing, dir, target, ctx)
          : await interactively(use, comp, collected, existing, dir, target, ctx);
        if (outcome) failures.push(outcome);
      }
    }
  } catch (error) {
    if (error instanceof Abort) {
      ctx.term.err('Stopped. Nothing was written.');
      return 1;
    }
    throw error;
  }

  if (opts.nonInteractive && failures.length > 0) {
    for (const f of failures) ctx.term.err(f);
    ctx.term.err('Nothing was written.');
    return 1;
  }

  return target === 'compose'
    ? writeCompose(collected, envPath, existingText, dir, config, ctx)
    : writeKubernetes(config, collected, opts.namespace ?? AGENT_NAMESPACE, ctx);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Why a file cannot be used as a secret, in words that fit where `init` runs: inside the agent
 * container, only the bundle folder is visible, so a host path like C:\Users\... is not.
 */
async function fileProblem(path: string, shown: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return `${shown} is a folder. Give the file itself (for a kubeconfig, usually the file named config inside .kube).`;
    }
    return null;
  } catch {
    return existsSync('/.dockerenv')
      ? `Cannot find ${shown}. This runs inside the agent container, which only sees the bundle folder: copy the file into it first.`
      : `Cannot find ${shown}.`;
  }
}

/** Where a ${file:/secrets/...} reference lives next to the bundle (compose mounts ./secrets). */
function hostFilePath(dir: string, containerPath: string): string | null {
  if (!containerPath.startsWith('/secrets/')) return null;
  const inside = containerPath.slice('/secrets/'.length);
  const target = resolve(dir, 'secrets', inside);
  return relative(join(dir, 'secrets'), target).startsWith('..') ? null : target;
}

async function probeFor(
  use: SecretUse,
  comp: Component,
  collected: Collected,
  ctx: Context,
): Promise<ProbeResult> {
  const secrets: Record<string, string> = {};
  for (const [other, value] of collected) {
    if (other.component === comp.id) secrets[other.spec.key] = value;
  }
  return runProbe(use.spec.probe, {
    component: comp,
    secrets,
    fetch: ctx.fetch,
    kubernetes: ctx.kubernetes,
    timeoutMs: ctx.probeTimeoutMs,
    ...(ctx.endpoints ? { endpoints: ctx.endpoints } : {}),
  });
}

function report(use: SecretUse, result: ProbeResult, ctx: Context): void {
  const line = `  ${result.status.toUpperCase()}  ${secretLabel(use)}: ${result.message}`;
  if (result.status === 'fail') {
    ctx.term.err(line);
    if (result.hint) ctx.term.err(`        ${result.hint}`);
  } else {
    ctx.term.out(line);
  }
}

async function interactively(
  use: SecretUse,
  comp: Component,
  collected: Collected,
  existing: ReadonlyMap<string, string>,
  dir: string,
  target: 'compose' | 'kubernetes',
  ctx: Context,
): Promise<string | null> {
  const prompter = ctx.prompter;
  if (!prompter) throw new Abort();
  const label = secretLabel(use);

  if (use.ref.scheme === 'env') {
    const current = existing.get(use.ref.name);
    if (current && (await prompter.confirm(`${label} is already set. Keep it?`, true))) {
      return null;
    }
  } else if (target === 'compose') {
    const dest = hostFilePath(dir, use.ref.path);
    if (dest && (await readOptional(dest)) !== null) {
      if (await prompter.confirm(`${label} is already in place. Keep it?`, true)) return null;
    }
  }

  for (;;) {
    let value: string;
    if (use.ref.scheme === 'env') {
      value = await prompter.secret(
        `${label}${isSecretRequired(use.spec, target) ? '' : ' (optional, Enter to skip)'}:`,
      );
    } else {
      // On compose, file secrets live in the bundle's secrets/ folder. `init` usually runs in
      // the container, which sees only the bundle folder, so say where to put the file.
      const dest = target === 'compose' ? hostFilePath(dir, use.ref.path) : null;
      if (dest) {
        ctx.term.out(
          `  ${label}: copy the file into this bundle folder as ${relative(dir, dest).split(sep).join('/')} (the agent reads it at ${use.ref.path}).`,
        );
      }
      const sourcePath = (
        await prompter.text(
          dest
            ? `Path to the file for ${label}, or Enter once it is in place:`
            : `Path to the file for ${label}:`,
        )
      ).trim();
      let from: string | null = null;
      if (sourcePath !== '') from = resolve(dir, sourcePath);
      else if (dest && (await readOptional(dest)) !== null) from = dest;
      if (from === null) {
        value = '';
      } else {
        const problem = await fileProblem(from, sourcePath || from);
        if (problem) {
          ctx.term.err(`  ${problem}`);
          continue;
        }
        value = (await readFile(from, 'utf8')).replace(/\r?\n$/, '');
      }
    }

    if (value === '') {
      if (!isSecretRequired(use.spec, target)) {
        ctx.term.out(`  SKIP  ${label}: left out`);
        return null;
      }
      const next = await prompter.choice(`${label} is required.`, [
        { value: 'retry', label: 'Enter it' },
        { value: 'skip', label: 'Skip for now (doctor will report it)' },
        { value: 'abort', label: 'Stop' },
      ]);
      if (next === 'abort') throw new Abort();
      if (next === 'skip') return null;
      continue;
    }

    ctx.redactor.add(value);
    collected.set(use, value);
    const result = await probeFor(use, comp, collected, ctx);
    report(use, result, ctx);
    if (result.status !== 'fail') return null;

    const next = await prompter.choice('What now?', [
      { value: 'retry', label: 'Enter it again' },
      { value: 'keep', label: 'Keep it anyway' },
      { value: 'abort', label: 'Stop' },
    ]);
    if (next === 'abort') throw new Abort();
    if (next === 'keep') return null;
    collected.delete(use);
  }
}

async function fromEnvironment(
  use: SecretUse,
  comp: Component,
  collected: Collected,
  existing: ReadonlyMap<string, string>,
  dir: string,
  target: 'compose' | 'kubernetes',
  ctx: Context,
): Promise<string | null> {
  const label = secretLabel(use);
  let value: string | undefined;
  if (use.ref.scheme === 'env') {
    value = ctx.env[use.ref.name] ?? existing.get(use.ref.name);
  } else {
    const path = target === 'compose' ? hostFilePath(dir, use.ref.path) : use.ref.path;
    value = path ? ((await readOptional(path))?.replace(/\r?\n$/, '') ?? undefined) : undefined;
  }
  if (value === undefined || value === '') {
    return isSecretRequired(use.spec, target) ? `Missing ${label}.` : null;
  }
  ctx.redactor.add(value);
  collected.set(use, value);
  const result = await probeFor(use, comp, collected, ctx);
  report(use, result, ctx);
  return result.status === 'fail' ? `${label} failed its check.` : null;
}

async function writeCompose(
  collected: Collected,
  envPath: string,
  existingText: string | null,
  dir: string,
  config: AgentConfig,
  ctx: Context,
): Promise<number> {
  const envValues = new Map<string, string>();
  for (const [use, value] of collected) {
    if (use.ref.scheme === 'env') envValues.set(use.ref.name, value);
  }
  // The console sign-in token: created once, kept on later runs.
  const hasToken = parseEnvFile(existingText ?? '').get(CONSOLE_TOKEN_ENV);
  if (config.spec.console.enabled && !hasToken) {
    envValues.set(CONSOLE_TOKEN_ENV, newConsoleToken());
    ctx.term.out(
      `Created a console sign-in token in .env (${CONSOLE_TOKEN_ENV}). After docker compose up, open http://localhost:${String(config.spec.console.port)} and sign in with it.`,
    );
  }
  if (envValues.size > 0) {
    await writePrivateFile(envPath, renderEnvFile(existingText, envValues, ENV_HEADER));
    ctx.term.out(
      `Wrote ${String(envValues.size)} value${envValues.size === 1 ? '' : 's'} to ${envPath} (owner-only).`,
    );
  }
  for (const [use, value] of collected) {
    if (use.ref.scheme !== 'file') continue;
    const dest = hostFilePath(dir, use.ref.path);
    if (!dest) {
      ctx.term.err(`Put ${secretLabel(use)} at ${use.ref.path} yourself: it is outside ./secrets.`);
      continue;
    }
    await writePrivateFile(
      dest,
      `${value}
`,
    );
    ctx.term.out(`Stored ${secretLabel(use)} at ${dest} (owner-only).`);
  }
  ctx.term.out('Done. Next: docker compose up -d, then kodra-agent doctor to check everything.');
  return 0;
}

async function writeKubernetes(
  config: AgentConfig,
  collected: Collected,
  namespace: string,
  ctx: Context,
): Promise<number> {
  const data: Record<string, string> = {};
  for (const [use, value] of collected) {
    data[use.ref.scheme === 'env' ? use.ref.name : use.spec.key] = value;
  }
  // The console sign-in token. The Secret is rewritten as a whole, so each run makes a new one.
  if (config.spec.console.enabled) data[CONSOLE_TOKEN_ENV] = newConsoleToken();
  if (Object.keys(data).length === 0) {
    ctx.term.out('No values entered. Nothing was written.');
    return 0;
  }
  const name = `${config.metadata.name}-secrets`;
  try {
    const action = await ctx.kubernetes().upsertSecret(namespace, name, data);
    ctx.term.out(
      `${action === 'created' ? 'Created' : 'Updated'} Secret ${namespace}/${name} with ${String(Object.keys(data).length)} key(s).`,
    );
    if (config.spec.console.enabled) {
      ctx.term.out(
        `The console sign-in token is key ${CONSOLE_TOKEN_ENV} of that Secret: kubectl --namespace ${namespace} get secret ${name} -o jsonpath='{.data.${CONSOLE_TOKEN_ENV}}' | base64 -d`,
      );
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    ctx.term.err(
      `Could not write Secret ${namespace}/${name}${typeof code === 'number' ? ` (HTTP ${String(code)})` : ''}.`,
    );
    ctx.term.err('Check your kube context and that the namespace exists, or use --dry-run.');
    return 1;
  }
  return 0;
}

/** The Secret manifest with placeholders. Values are never printed (golden rule 1). */
export function dryRunManifest(
  config: AgentConfig,
  uses: readonly SecretUse[],
  namespace: string,
): string {
  const name = `${config.metadata.name}-secrets`;
  const stringData: Record<string, string> = {};
  const envNames: string[] = [];
  const files: string[] = [];
  if (config.spec.console.enabled) {
    stringData[CONSOLE_TOKEN_ENV] = '<a long random string: the console sign-in token>';
  }
  for (const use of uses) {
    if (use.ref.scheme === 'env') {
      stringData[use.ref.name] = `<${use.ref.name}>`;
      envNames.push(use.ref.name);
    } else {
      stringData[use.spec.key] = `<contents of your ${use.spec.key} file>`;
      files.push(`--from-file=${use.spec.key}=<path to ${use.spec.key}>`);
    }
  }
  const manifest = stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: { name, namespace },
    stringData,
  });
  const create = [
    `kubectl create secret generic ${name} --namespace ${namespace}`,
    ...(envNames.length > 0 ? ['--from-env-file=.env'] : []),
    ...files,
  ].join(' \\\n    ');
  return [
    `# Secret for ${config.metadata.name}, with placeholders instead of values.`,
    '# Replace each placeholder, then: kubectl apply -f <this file>',
    '# Or create it directly from a local .env (keys must match the names below):',
    ...create.split('\n').map((l) => `#   ${l}`),
    manifest.trimEnd(),
  ].join('\n');
}
