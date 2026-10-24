import { readFile } from 'node:fs/promises';
import { WriteGate } from './write-gate.ts';
import { dirname, join } from 'node:path';
import {
  defaultDetectors,
  isSecretRequired,
  resolvePolicy,
  type AgentConfig,
} from '@kodra-agent/schema';
import type { LanguageModel } from 'ai';
import { AGENT_VERSION } from '@kodra-agent/templates';
import { costOf, priceFor, readAudit } from './console/data.ts';
import { startTracer, type AgentTracer } from './tracing.ts';
import { AgentMetrics } from './metrics.ts';
import { DataMasker } from './data-protection.ts';
import { alwaysBlocked, type AgentDeps } from './agent.ts';
import { applyNetwork, networkSettings, type NetworkSettings } from './network.ts';
import { selfTarget } from './policy.ts';
import type { ApprovalChannel } from './approvals.ts';
import { AuditLog } from './audit.ts';
import { budgetState, type BudgetState } from './budget.ts';
import { components, loadConfig, secretLabel } from './config.ts';
import { BROAD_HINT, BROAD_REASON, startupScopeProblem } from './credential-scope.ts';
import { AgentControl } from './control.ts';
import { CONSOLE_TOKEN_ENV } from './console/token.ts';
import type { Context } from './context.ts';
import { lookupDefaultBranches } from './default-branches.ts';
import { forgeFileReader } from './forge-files.ts';
import { parseEnvFile } from './env-file.ts';
import { fileLogger } from './io.ts';
import { createModel } from './llm.ts';
import { ollamaContext } from './model-context.ts';
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
  /** The agent's own metrics (M14), fed by the audit log. */
  metrics: AgentMetrics;
  /** OpenTelemetry traces (M14); a no-op unless spec.tracing is on. */
  tracer: AgentTracer;
  /** Proxy and CA variables for child processes (git, helm, docker, MCP servers). */
  networkEnv: Readonly<Record<string, string>>;
  /** The resolved proxy and CA settings, for clients with their own HTTP stack (Slack). */
  network: NetworkSettings;
  /** Agent dependencies for one turn or investigation, with a given approval channel. */
  deps: (approvals: ApprovalChannel) => AgentDeps;
  /** The pause switch (saved next to the audit log). */
  control: AgentControl;
  /** This month's estimated spend against spec.limits.monthlyBudgetUsd. */
  budget: () => Promise<BudgetState>;
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
  /** `run` only: spec.audit.stdout writes each record to stdout too (M14). */
  auditToStdout?: boolean;
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
  // Console sign-in tokens (shared and per approver) are secrets like any other.
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(CONSOLE_TOKEN_ENV) && value) ctx.redactor.add(value);
  }
  // Customer data is masked wherever secrets are (M13), with a key made for this run.
  ctx.redactor.setMasker(
    new DataMasker({
      redact: config.spec.dataProtection.redact ?? defaultDetectors(config.spec.profile),
      patterns: config.spec.dataProtection.patterns,
    }),
  );
  // Proxy and CA first: every connection after this goes through them (M12).
  const settings = networkSettings(config, env);
  const network = await applyNetwork(settings, ctx.redactor, ctx.networkRuntime);
  for (const problem of network.problems) ctx.term.err(`Network: ${problem}.`);

  const inputs: ConnectorInput[] = [];
  let modelSecrets: Record<string, string> = {};
  const namedSecrets = new Map<string, Record<string, string>>();
  const missing: string[] = [];
  // A connector missing a required secret is skipped (the agent runs without it); only a
  // missing model key stops the agent, because nothing works without the model.
  const skipped: ConnectorFailure[] = [];
  for (const comp of components(config)) {
    const resolved = await resolveAll(comp.secrets, { env, redactor: ctx.redactor });
    const gaps = resolved.missing
      .filter((gap) => isSecretRequired(gap.use.spec, config.spec.target))
      .map((gap) => `${secretLabel(gap.use)}: ${gap.reason}`);
    if (comp.named !== undefined) {
      // A named model without its key is not available: environments that pin it refuse.
      if (gaps.length > 0) ctx.term.err(`Model ${comp.named} is not available: ${gaps.join('; ')}`);
      else namedSecrets.set(comp.named, resolved.values);
      continue;
    }
    if (comp.manifest.category === 'model') {
      missing.push(...gaps);
      modelSecrets = resolved.values;
      continue;
    }
    if (gaps.length > 0) {
      skipped.push({
        connector: comp.id,
        displayName: comp.displayName,
        server: undefined,
        reason: `missing ${gaps.join('; ')}`,
      });
      continue;
    }
    // A credential that reaches further than the agent needs is refused (M29).
    const scope = await startupScopeProblem(
      comp,
      resolved.values,
      ctx.kubernetes,
      ctx.probeTimeoutMs,
    );
    if (scope && 'refused' in scope) {
      skipped.push({
        connector: comp.id,
        displayName: comp.displayName,
        server: undefined,
        reason: scope.refused,
      });
      continue;
    }
    if (scope) {
      ctx.term.err(
        `${comp.displayName}: kept with more access than it needs (allowBroadCredentials): ${scope.kept.join('; ')}`,
      );
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
      const readFile = forgeFileReader(input.component, input.secrets['token'], {
        fetch: ctx.fetch,
        timeoutMs: ctx.probeTimeoutMs,
        githubApi: ctx.endpoints?.github,
      });
      if (readFile) input.readFile = readFile;
    }
  }

  // Metrics come from the audit records as they are written (M14).
  const labels = [
    `${config.spec.model.provider}/${config.spec.model.name}`,
    ...Object.values(config.spec.models).map((m) => `${m.provider}/${m.name}`),
  ];
  const metrics = new AgentMetrics({
    version: AGENT_VERSION,
    models: labels,
    cost: (model, usage) =>
      costOf(
        {
          calls: 1,
          input: usage['input'] ?? 0,
          cacheRead: usage['cacheRead'] ?? 0,
          cacheWrite: usage['cacheWrite'] ?? 0,
          output: usage['output'] ?? 0,
        },
        priceFor(model, config.spec.console.pricing)?.price,
      ) ?? 0,
  });
  const tracer = await startTracer(config.spec.tracing, AGENT_VERSION, ctx.spanExporter);
  const toStdout = options.auditToStdout === true && config.spec.audit.stdout;
  const audit = new AuditLog(config.spec.audit.path, ctx.redactor, {
    onRecord: (line: string) => {
      metrics.observe(JSON.parse(line) as Record<string, unknown>);
      if (toStdout) ctx.term.out(line);
    },
  });
  // A connector that cannot start is skipped, not fatal: the agent works with the rest.
  const connectorLogPath = join(dirname(config.spec.audit.path), 'connectors.log');
  const host = await ConnectorHost.start(inputs, {
    skipped,
    redactor: ctx.redactor,
    log: options.connectorLogFile ? fileLogger(connectorLogPath, ctx.redactor) : ctx.log,
    audit,
    env,
    networkEnv: network.childEnv,
    ...(ctx.launcher ? { launcher: ctx.launcher } : {}),
  });
  for (const failure of host.failures()) {
    ctx.term.err(`${failure.displayName} is not available: ${failure.reason}`);
    ctx.term.err(`  ${failureHint(failure, config, inputs, env)}`);
  }
  const down = new Set(host.failures().map((f) => f.connector));
  for (const input of inputs)
    metrics.setConnectorUp(input.component.id, !down.has(input.component.id));
  for (const failure of skipped) metrics.setConnectorUp(failure.connector, false);

  const model = (ctx.modelFactory ?? createModel)(config.spec.model, modelSecrets);
  const control = new AgentControl(config.spec.audit.path, audit);
  await control.load();
  const modelLabel = `${config.spec.model.provider}/${config.spec.model.name}`;
  const models: Record<string, { model: LanguageModel; label: string }> = {};
  for (const [name, named] of Object.entries(config.spec.models)) {
    const secrets = namedSecrets.get(name);
    if (!secrets) continue;
    models[name] = {
      model: (ctx.modelFactory ?? createModel)(named, secrets),
      label: `${named.provider}/${named.name}`,
    };
  }
  // Ollama: the window it runs the model with, read again at most every 30 seconds (it changes
  // when Ollama restarts with another OLLAMA_CONTEXT_LENGTH).
  const ollama = config.spec.model.provider === 'ollama' ? config.spec.model : null;
  let windowCache: { at: number; value: number | null } | null = null;
  const contextWindow = ollama
    ? async () => {
        if (windowCache && Date.now() - windowCache.at < 30_000) return windowCache.value;
        const { loaded } = await ollamaContext(ollama.baseUrl, ollama.name, ctx.fetch);
        windowCache = { at: Date.now(), value: loaded };
        return loaded;
      }
    : null;
  // Shared by every turn, Slack, the console, and alerts; a restart keeps the hour (M29).
  const writes = new WriteGate(config.spec.limits.maxWritesPerHour);
  const hourAgo = Date.now() - 60 * 60 * 1000;
  writes.seed(
    (await readAudit(config.spec.audit.path).catch(() => []))
      .filter((r) => r.event === 'tool.call' && r.decision === 'approved')
      .map((r) => Date.parse(r.ts))
      .filter((t) => t > hourAgo),
  );
  return {
    config,
    inputs,
    host,
    ...(options.connectorLogFile ? { connectorLogPath } : {}),
    audit,
    env,
    control,
    budget: () =>
      budgetState({
        auditPath: config.spec.audit.path,
        model: modelLabel,
        pricing: config.spec.console.pricing,
        limit: config.spec.limits.monthlyBudgetUsd,
      }),
    networkEnv: network.childEnv,
    network: settings,
    metrics,
    deps: (approvals) => ({
      ...(contextWindow ? { contextWindow } : {}),
      model,
      modelLabel,
      models,
      paused: control.reason,
      writes,
      host,
      approvals,
      audit,
      redactor: ctx.redactor,
      term: ctx.term,
      policy: {
        destructiveActions: config.spec.policy.destructiveActions,
        effective: resolvePolicy(config.spec),
        self: selfTarget(env),
      },
      limits: ctx.limits ?? {
        maxSteps: config.spec.limits.maxSteps,
        tokenBudget: config.spec.limits.tokenBudget,
        timeoutMs: config.spec.limits.timeoutMinutes * 60_000,
      },
      actor: 'agent',
      tracer,
    }),
    tracer,
    close: async () => {
      await host.close();
      await tracer.shutdown().catch(() => undefined);
    },
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
  if (failure.reason.startsWith(BROAD_REASON)) return BROAD_HINT;
  if (
    failure.connector === 'kubernetes' &&
    config.spec.target === 'compose' &&
    input?.secrets['kubeconfig'] === undefined
  ) {
    return config.spec.console.enabled
      ? 'On Docker Compose, Kubernetes needs a kubeconfig: upload it in the console under Settings, Connectors, Kubernetes, which shows how to make one.'
      : 'On Docker Compose, Kubernetes needs a kubeconfig: copy it to secrets/kubeconfig in the bundle folder, then restart.';
  }
  if (failure.reason.startsWith('missing ')) {
    return config.spec.console.enabled
      ? 'The agent runs without it. Set it in the console under Settings, Connectors.'
      : 'The agent runs without it. Run `kodra-agent init` to set it, then restart.';
  }
  // Only a source checkout fetches server binaries; the agent image has them preinstalled.
  if (!env['KODRA_MCP_DIR'] && /no .* server build|ENOENT/.test(failure.reason)) {
    return 'The server binary is missing. In a source checkout, run: pnpm mcp:fetch';
  }
  return 'The agent runs without it. Run `kodra-agent doctor` to check this connector.';
}

/** One line per connector: access level and tool count, or why it is not available. */
export function describeConnectors(runtime: Runtime): string[] {
  // Count what the model is offered: tools the policy always blocks are left out.
  const policy = {
    destructiveActions: runtime.config.spec.policy.destructiveActions,
    effective: resolvePolicy(runtime.config.spec),
  };
  const counts = new Map<string, number>();
  for (const tool of runtime.host.tools()) {
    if (alwaysBlocked(tool, policy, false)) continue;
    counts.set(tool.connector, (counts.get(tool.connector) ?? 0) + 1);
  }
  const failed = new Map(runtime.host.failures().map((f) => [f.connector, f.reason]));
  const notStarted = runtime.host
    .failures()
    .filter((f) => !runtime.inputs.some((i) => i.component.id === f.connector))
    .map((f) => `${f.displayName}: not available (${f.reason.split('\n')[0] ?? f.reason})`);
  return [...connectorLines(runtime, counts, failed), ...notStarted];
}

function connectorLines(
  runtime: Runtime,
  counts: ReadonlyMap<string, number>,
  failed: ReadonlyMap<string, string>,
): string[] {
  return runtime.inputs.map((input) => {
    const name = input.component.displayName;
    const reason = failed.get(input.component.id);
    if (reason !== undefined && !counts.has(input.component.id)) {
      const short = reason.split('\n')[0] ?? reason;
      return `${name}: not available (${short.length > 160 ? `${short.slice(0, 157)}...` : short})`;
    }
    // Connectors without an MCP server (Docker, Slack) give the model no tools.
    const runtime = input.component.manifest.runtime;
    if (runtime === null) {
      const use = input.component.manifest.category === 'build' ? ', used by `ship`' : '';
      return `${name}: ${input.access ?? 'on'}${use}`;
    }
    const n = counts.get(input.component.id) ?? 0;
    return `${name}: ${input.access ?? 'on'}, ${String(n)} tool${n === 1 ? '' : 's'}`;
  });
}
