import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSecretRequired, type AgentConfig } from '@kodra-agent/schema';
import type { AgentDeps } from './agent.ts';
import type { ApprovalChannel } from './approvals.ts';
import { AuditLog } from './audit.ts';
import { components, loadConfig, secretLabel } from './config.ts';
import type { Context } from './context.ts';
import { lookupDefaultBranches } from './default-branches.ts';
import { parseEnvFile } from './env-file.ts';
import { fileLogger } from './io.ts';
import { createModel } from './llm.ts';
import { ConnectorHost, type ConnectorFailure, type ConnectorInput } from './mcp/host.ts';
import { resolveAll } from './secrets.ts';

/** Everything `chat` and `run` share once the config is loaded and connectors started. */
export interface Runtime {
  config: AgentConfig;
  /** Where connector output goes, when not to the terminal. */
  connectorLogPath?: string;
  inputs: ConnectorInput[];
  host: ConnectorHost;
  audit: AuditLog;
  env: Readonly<Record<string, string | undefined>>;
  /** Agent dependencies for one turn or investigation, with a given approval channel. */
  deps: (approvals: ApprovalChannel) => AgentDeps;
  close: () => Promise<void>;
}

/**
 * Loads the config, resolves secrets (also from the .env next to it), shares values only
 * between connectors that require each other, looks up default branches, starts the
 * connector host, and builds the model. Prints problems and returns null on failure.
 */
export interface RuntimeOptions {
  /**
   * Write connector output (server logs on stderr) to connectors.log next to the audit log
   * instead of the terminal, so it never interleaves with a `chat` conversation.
   */
  connectorLogFile?: boolean;
}

export async function startRuntime(
  configPath: string,
  ctx: Context,
  options: RuntimeOptions = {},
): Promise<Runtime | null> {
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    for (const e of loaded.errors) ctx.term.err(e);
    return null;
  }
  const { config, dir } = loaded;

  // Inside the container compose already loads .env; outside it, read it too.
  const dotenvText = await readFile(join(dir, '.env'), 'utf8').catch(() => '');
  const env = { ...Object.fromEntries(parseEnvFile(dotenvText)), ...ctx.env };

  const inputs: ConnectorInput[] = [];
  let modelSecrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const comp of components(config)) {
    const resolved = await resolveAll(comp.secrets, { env, redactor: ctx.redactor });
    for (const gap of resolved.missing) {
      if (isSecretRequired(gap.use.spec, config.spec.target))
        missing.push(`${secretLabel(gap.use)}: ${gap.reason}`);
    }
    if (comp.manifest.category === 'model') {
      modelSecrets = resolved.values;
      continue;
    }
    const entry = config.spec.connectors[comp.id];
    const access = comp.manifest.accessLevels.length > 0 ? entry?.access : undefined;
    inputs.push({ component: comp, access, secrets: resolved.values });
  }
  if (missing.length > 0) {
    for (const m of missing) ctx.term.err(`Missing ${m}`);
    ctx.term.err('Run `kodra-agent init`, then `kodra-agent doctor`.');
    return null;
  }

  // A connector may use another's token and settings only if it requires that connector
  // (GitHub Actions uses GitHub's). Default branches are looked up once, read-only.
  const byId = new Map(inputs.map((i) => [i.component.id, i]));
  for (const input of inputs) {
    const required = input.component.manifest.requires.flatMap((r) =>
      r.anyOf.flatMap((alt) => ('connector' in alt ? [alt.connector] : [])),
    );
    const sharedSecrets: Record<string, Readonly<Record<string, string>>> = {};
    const sharedSettings: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const id of required) {
      const other = byId.get(id);
      if (!other) continue;
      sharedSecrets[id] = other.secrets;
      sharedSettings[id] = other.component.settings;
    }
    if (required.length > 0) Object.assign(input, { sharedSecrets, sharedSettings });
    if (input.component.manifest.defaultBranchLookup) {
      const branches = await lookupDefaultBranches(input.component, input.secrets['token'], {
        fetch: ctx.fetch,
        timeoutMs: ctx.probeTimeoutMs,
        githubApi: ctx.endpoints?.github,
      });
      for (const [repo, branch] of branches) {
        if (branch === null) {
          ctx.term.err(
            `Could not look up the default branch of ${repo}; changes to it are blocked.`,
          );
        }
      }
      input.defaultBranches = branches;
    }
  }

  const audit = new AuditLog(config.spec.audit.path, ctx.redactor);
  // A connector that cannot start is skipped, not fatal: the agent works with the rest.
  const connectorLogPath = join(dirname(config.spec.audit.path), 'connectors.log');
  const host = await ConnectorHost.start(inputs, {
    redactor: ctx.redactor,
    log: options.connectorLogFile ? fileLogger(connectorLogPath, ctx.redactor) : ctx.log,
    audit,
    env,
    ...(ctx.launcher ? { launcher: ctx.launcher } : {}),
  });
  for (const failure of host.failures()) {
    ctx.term.err(`${failure.displayName} is not available: ${failure.reason}`);
    ctx.term.err(`  ${failureHint(failure, config, inputs, env)}`);
  }

  const model = (ctx.modelFactory ?? createModel)(config.spec.model, modelSecrets);
  return {
    config,
    inputs,
    host,
    ...(options.connectorLogFile ? { connectorLogPath } : {}),
    audit,
    env,
    deps: (approvals) => ({
      model,
      modelLabel: `${config.spec.model.provider}/${config.spec.model.name}`,
      host,
      approvals,
      audit,
      redactor: ctx.redactor,
      term: ctx.term,
      policy: {
        destructiveActions: config.spec.policy.destructiveActions,
        expiresAfterMinutes: config.spec.policy.approvals.expiresAfterMinutes,
      },
      ...(ctx.limits ? { limits: ctx.limits } : {}),
      actor: 'agent',
    }),
    close: () => host.close(),
  };
}

/** What to do about a connector that did not start. */
export function failureHint(
  failure: ConnectorFailure,
  config: AgentConfig,
  inputs: readonly ConnectorInput[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  const input = inputs.find((i) => i.component.id === failure.connector);
  if (
    failure.connector === 'kubernetes' &&
    config.spec.target === 'compose' &&
    input?.secrets['kubeconfig'] === undefined
  ) {
    return 'On Docker Compose, Kubernetes needs a kubeconfig: copy it to secrets/kubeconfig in the bundle folder, then restart.';
  }
  // Only a source checkout fetches server binaries; the agent image has them preinstalled.
  if (!env['KODRA_MCP_DIR'] && /no .* server build|ENOENT/.test(failure.reason)) {
    return 'The server binary is missing. In a source checkout, run: pnpm mcp:fetch';
  }
  return 'The agent runs without it. Run `kodra-agent doctor` to check this connector.';
}

/** One line per connector: access level and tool count, or why it is not available. */
export function describeConnectors(runtime: Runtime): string[] {
  const counts = new Map<string, number>();
  for (const tool of runtime.host.tools())
    counts.set(tool.connector, (counts.get(tool.connector) ?? 0) + 1);
  const failed = new Map(runtime.host.failures().map((f) => [f.connector, f.reason]));
  return runtime.inputs.map((input) => {
    const name = input.component.displayName;
    const reason = failed.get(input.component.id);
    if (reason !== undefined && !counts.has(input.component.id)) {
      const short = reason.split('\n')[0] ?? reason;
      return `${name}: not available (${short.length > 160 ? `${short.slice(0, 157)}...` : short})`;
    }
    // Connectors without an MCP server (Docker, Slack) give the model no tools.
    const runtime = input.component.manifest.runtime;
    if (runtime === null || (!Array.isArray(runtime) && runtime.type === 'builtin')) {
      const use = input.component.manifest.category === 'build' ? ', used by `ship`' : '';
      return `${name}: ${input.access ?? 'on'}${use}`;
    }
    const n = counts.get(input.component.id) ?? 0;
    return `${name}: ${input.access ?? 'on'}, ${String(n)} tool${n === 1 ? '' : 's'}`;
  });
}
