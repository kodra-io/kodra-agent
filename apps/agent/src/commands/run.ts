import { proxyOptions } from '../network.ts';
import { doctorRows } from './doctor.ts';
import { OnboardJobs } from '../console/onboard.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { formatUsage, runTurn, SYSTEM_PROMPT } from '../agent.ts';
import { baselinePromptTokens } from '../model-context.ts';
import {
  allApprovers,
  consoleApproverTokenEnv,
  isTokenApprover,
  resolvePolicy,
} from '@kodra-agent/schema';
import { fanOut, type ApprovalChannel, type SettleableChannel } from '../approvals.ts';
import { ADMIN_HASH_ENV, ADMIN_USER, AdminAccount } from '../console/admin.ts';
import { ConsoleApprovals } from '../console/approvals.ts';
import { ConsoleChat } from '../console/chat.ts';
import { budgetRefusal } from '../budget.ts';
import { InvestigationLog } from '../console/data.ts';
import {
  fileBackend,
  kubernetesBackend,
  realSelfKubernetes,
  selfNames,
  startupConfig,
} from '../console/config-backend.ts';
import { People } from '../console/people.ts';
import { PolicyGate } from '../console/policy-gate.ts';
import { consoleApi } from '../console/routes.ts';
import { SettingsStore } from '../console/settings.ts';
import { sandboxSetup, sandboxSweep } from '../sandbox/sandbox.ts';
import { SessionRegistry, startConsoleServer, type ConsoleAccount } from '../console/server.ts';
import { CONSOLE_TOKEN_ENV } from '../console/token.ts';
import type { Context } from '../context.ts';
import type { CheckRunner } from '../checks/runner.ts';
import { alertSource, checkRunner, connectorDashboard } from '../checks/setup.ts';
import { AlertMonitor, investigationPrompt } from '../monitoring/monitor.ts';
import { describeConnectors, startRuntime, type Runtime } from '../runtime.ts';
import { boltSlack, type SlackApi, type SlackConnection } from '../slack/api.ts';
import { SlackApprovals } from '../slack/approvals.ts';
import { resolveApprovers } from '../slack/approvers.ts';
import { SlackConversations } from '../slack/conversations.ts';

export interface RunOptions {
  configPath: string;
}

/** Investigations never change anything, so they never ask for approval. */
const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'investigation' }),
};

const DEFAULT_HEALTH_PORT = 8080;
/** How often `run` removes sandbox tests that are past their time (B2). */
const SWEEP_MS = 5 * 60_000;
/** The exit code for "restart me": settings changed (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;

/**
 * The service: Slack (Socket Mode) for conversations and approvals, the alert monitoring
 * loop, and /healthz and /readyz. Runs until SIGTERM or SIGINT (or ctx.stopSignal), then
 * stops taking work, refuses open approvals, and shuts down connectors.
 */
export async function run(opts: RunOptions, ctx: Context): Promise<number> {
  let ready = false;
  let unavailable: string[] = [];
  const health = await startHealthServer(
    ctx,
    () => ready,
    () => unavailable,
  );
  // Kubernetes: start from the console's saved copy if it was made from this Helm config.
  const self = selfNames(ctx.env);
  let configPath = opts.configPath;
  if (self) {
    const chosen = await startupConfig(opts.configPath, self.settingsDir).catch(() => null);
    if (chosen?.setAside) {
      ctx.term.out(
        'The config from Helm changed since settings were saved in the console: using it, and setting the console copy aside.',
      );
    }
    configPath = chosen?.path ?? configPath;
  }
  const runtime = await startRuntime(configPath, ctx, { auditToStdout: true });
  if (!runtime) {
    await closeServer(health);
    return 1;
  }
  unavailable = [...new Set(runtime.host.failures().map((f) => f.displayName))];

  const startedAt = new Date();
  const restart = new AbortController();
  const investigationLog = new InvestigationLog(runtime.config.spec.audit.path, ctx.redactor);
  let consoleServer: Server | null = null;
  let metricsServer: Server | null = null;
  const consoleOn = runtime.config.spec.console.enabled;
  const consoleApprovals = new ConsoleApprovals({ audit: runtime.audit });
  let consoleChat: ConsoleChat | null = null;
  // Console approvers who can sign in: each needs their own token.
  const consoleAccounts: ConsoleAccount[] = [];
  const everyApprover = allApprovers(resolvePolicy(runtime.config.spec));
  // The admin signs in with a password, and approves where console:admin is an approver.
  const adminCanApprove = consoleOn && everyApprover.includes(ADMIN_USER);
  // No default console password (L2): without one set by init, the agent does not start.
  const admin = new AdminAccount({
    path: join(dirname(runtime.config.spec.audit.path), 'console-users.json'),
    envHash: runtime.env[ADMIN_HASH_ENV],
    audit: runtime.audit,
  });
  if (consoleOn) {
    const envHash = runtime.env[ADMIN_HASH_ENV];
    if (envHash) ctx.redactor.add(envHash);
    const problem = await admin.load().then(
      () => (admin.isSet() ? null : 'the console admin has no password'),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (problem) {
      ctx.term.err(
        `The console cannot start: ${problem}. Run \`kodra-agent init\` to set it, or turn the console off (spec.console.enabled: false).`,
      );
      await runtime.close();
      await closeServer(health);
      return 1;
    }
    for (const entry of everyApprover.filter(isTokenApprover)) {
      const token = runtime.env[consoleApproverTokenEnv(entry)];
      if (token) consoleAccounts.push({ token, user: { name: entry, canApprove: true } });
      else {
        ctx.term.err(
          `${entry} cannot sign in to the console: ${consoleApproverTokenEnv(entry)} is not set. Run \`kodra-agent init\`.`,
        );
      }
    }
  }
  const consoleChannels: SettleableChannel[] =
    consoleAccounts.length > 0 || adminCanApprove ? [consoleApprovals.channel] : [];
  // New questions stop when the monthly budget is used up; investigations keep running.
  const gate = async (): Promise<string | null> => {
    const refusal = budgetRefusal(await runtime.budget());
    if (refusal) {
      await runtime.audit.append({
        event: 'result',
        actor: 'agent',
        detail: 'refused a question: the monthly budget is used up',
      });
    }
    return refusal;
  };
  let slack: SlackConnection | null = null;
  let approvals: SlackApprovals | null = null;
  let conversations: SlackConversations | null = null;
  let timer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> = Promise.resolve();
  let sweepBusy = false;
  let monitor: AlertMonitor | null = null;
  let checks: CheckRunner | null = null;
  try {
    const slackInput = runtime.inputs.find((i) => i.component.id === 'slack');
    let channelId: string | null = null;
    let api: SlackApi | null = null;
    // Freeze overrides and policy changes are told to everyone in the agent's Slack channel.
    const announce = async (text: string) => {
      if (api && channelId) await api.postMessage({ channel: channelId, text });
    };
    const deps = (channel: ApprovalChannel) => ({ ...runtime.deps(channel), announce });
    if (slackInput) {
      const { botToken, appToken } = slackInput.secrets;
      if (!botToken || !appToken) {
        ctx.term.err('Slack needs both the bot token and the app token. Run `kodra-agent init`.');
        return 1;
      }
      slack = (ctx.slackConnection ?? boltSlack)(botToken, appToken, proxyOptions(runtime.network));
      api = slack.api;
      const approvers = resolveApprovers(everyApprover);
      for (const entry of approvers.unresolved) {
        ctx.term.err(
          `Approver ${entry} is a name, not a Slack user id, so it cannot approve. Run \`kodra-agent init\` to look it up.`,
        );
      }
      const channelSetting = String(slackInput.component.settings['channel']);
      const hello = await api
        .postMessage({ channel: channelSetting, text: ctx.redactor.redact(helloText(runtime)) })
        .catch((error: unknown) => {
          ctx.term.err(slackStartError(error, channelSetting));
          return null;
        });
      if (!hello) {
        // Keep running without Slack, so the console stays up to fix the settings.
        await slack.stop().catch(() => undefined);
        slack = null;
        api = null;
        unavailable = [...unavailable, 'Slack'];
      } else {
        channelId = hello.channel;
        approvals = new SlackApprovals({
          api,
          audit: runtime.audit,
          redactor: ctx.redactor,
        });
        conversations = new SlackConversations({
          api,
          approvals,
          redactor: ctx.redactor,
          channelId,
          approverIds: approvers.ids,
          deps,
          alsoAsk: consoleChannels,
          gate,
        });
        const conv = conversations;
        const appr = approvals;
        await slack.start({
          onMention: (m) => conv.onMention(m),
          onDirectMessage: (m) => conv.onDirectMessage(m),
          onSubmission: (s) => appr.handleSubmission(s),
          onAction: async (a) => {
            await appr.handleAction(a);
          },
        });
      }
    }

    const post = async (text: string) => {
      const safe = ctx.redactor.redact(text).slice(0, 39_000);
      if (api && channelId) await api.postMessage({ channel: channelId, text: safe });
      else ctx.term.out(safe);
    };
    runtime.control.onChange((state, who) => {
      void post(
        state
          ? `Changes are paused by ${who}. I keep answering and investigating, but I will not change anything until an approver resumes.`
          : `Changes are resumed by ${who}. Changes run again after approval.`,
      ).catch(() => undefined);
    });

    const prometheus = runtime.inputs.find((i) => i.component.id === 'prometheus');
    const fetchAlerts = alertSource(runtime, ctx);
    if (prometheus && fetchAlerts) {
      const settings = prometheus.component.settings;
      const intervalMs = Number(settings['pollIntervalSeconds'] ?? 60) * 1000;
      monitor = new AlertMonitor({
        limits: runtime.config.spec.monitoring,
        fetchAlerts,
        investigate: async (alert) => {
          const deps = { ...runtime.deps(refuseAll), readOnly: true, actor: 'monitor' };
          // The alert's namespace picks the model before the first call (M13).
          const namespace = alert.labels['namespace'];
          const env = resolvePolicy(runtime.config.spec).environments.find(
            (e) => e.model !== null && namespace !== undefined && e.namespaces.includes(namespace),
          );
          const result = await runTurn(
            deps,
            [],
            investigationPrompt(alert),
            `alert-${randomUUID().slice(0, 8)}`,
            env?.model ? { pin: { model: env.model, environment: env.name } } : {},
          );
          await investigationLog
            .append({
              ts: new Date().toISOString(),
              alert: alert.name,
              severity: alert.severity,
              summary: alert.annotations['summary'] ?? alert.annotations['description'] ?? '',
              findings: result.text,
              ...(result.stoppedBy ? { stoppedBy: result.stoppedBy } : {}),
            })
            .catch(() => undefined);
          return {
            text: `${result.text}\n_${formatUsage(result.usage)}_`,
            stoppedBy: result.stoppedBy,
          };
        },
        post,
        audit: runtime.audit,
        redactor: ctx.redactor,
      });
      const m = monitor;
      void m.poll();
      timer = setInterval(() => void m.poll(), intervalMs);
    }

    // Scheduled read-only checks (M27): a digest to the channel, also run from the console.
    const dashboard = connectorDashboard(runtime);
    checks = await checkRunner(runtime, ctx, {
      dashboard,
      post,
      pendingApprovals: () => consoleApprovals.list().length,
      ...(ctx.checksNow ? { now: ctx.checksNow } : {}),
    });
    if (checks.schedules.length > 0) checks.start();

    // Sandbox tests (B2): destroy what is past its time, at startup and every few minutes.
    if (sandboxSetup(runtime).ok) {
      const sweep = () => {
        if (sweepBusy) return;
        sweepBusy = true;
        sweeping = sandboxSweep(ctx, runtime)
          .then((r) => {
            if (r.destroyed.length > 0)
              ctx.term.out(`Sandbox: destroyed ${r.destroyed.join(', ')}.`);
            for (const p of r.problems) ctx.log.warn('sandbox sweep', { problem: p });
          })
          .catch((error: unknown) => {
            ctx.log.warn('sandbox sweep', {
              problem: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            sweepBusy = false;
          });
      };
      sweep();
      sweepTimer = setInterval(sweep, SWEEP_MS);
    }

    if (consoleOn) {
      const token = runtime.env[CONSOLE_TOKEN_ENV];
      if (runtime.config.spec.console.chat) {
        // A console question asks for approval in the console and in Slack's channel.
        const slackChannel =
          approvals && channelId ? [approvals.channelFor(channelId, undefined)] : [];
        consoleChat = new ConsoleChat({
          deps,
          approvals: fanOut([...consoleChannels, ...slackChannel]),
          redactor: ctx.redactor,
          gate,
        });
      }
      // Kubernetes: the chart names the agent's own objects and lets it patch only those.
      let kube: ReturnType<typeof kubernetesBackend> | null = null;
      if (self && runtime.config.spec.target === 'kubernetes') {
        try {
          kube = kubernetesBackend(
            (ctx.selfKubernetes ?? realSelfKubernetes)(),
            self,
            await readFile(opts.configPath, 'utf8'),
          );
        } catch (error) {
          ctx.term.err(
            `Settings are read-only: no access to the cluster (${error instanceof Error ? error.message : String(error)}).`,
          );
        }
      }
      const settings = new SettingsStore({
        backend: kube ?? fileBackend(opts.configPath),
        audit: runtime.audit,
        redactor: ctx.redactor,
        env: runtime.env,
        fetch: ctx.fetch,
        kubernetes: ctx.kubernetes,
        probeTimeoutMs: ctx.probeTimeoutMs,
        promptSize: () => baselinePromptTokens(SYSTEM_PROMPT, runtime.host.tools()),
      });
      // Sign-outs are kept next to the audit log, so a restart does not undo them.
      const sessions = new SessionRegistry({
        path: join(dirname(runtime.config.spec.audit.path), 'console-sessions.json'),
      });
      await sessions.load();
      const people = new People({ store: settings, sessions, env: runtime.env });
      // Policy changes from the console: announced (team) or held for a second approver
      // (strict), through the same approvals as any change.
      const effective = resolvePolicy(runtime.config.spec);
      const policyGate = new PolicyGate({
        mode: effective.policyChanges,
        approvals: fanOut([
          ...consoleChannels,
          ...(approvals && channelId ? [approvals.channelFor(channelId, undefined)] : []),
        ]),
        approvers: allApprovers(effective),
        expiresAfterMinutes: effective.default.expiresAfterMinutes,
        audit: runtime.audit,
        redactor: ctx.redactor,
        announce,
      });
      // Onboarding from the console (M30a): approvals in the console and Slack, as for chat.
      const onboard = new OnboardJobs({
        runtime,
        ctx,
        configPath: opts.configPath,
        approvals: fanOut([
          ...consoleChannels,
          ...(approvals && channelId ? [approvals.channelFor(channelId, undefined)] : []),
        ]),
        ...(slack ? { post: announce } : {}),
        path: join(dirname(runtime.config.spec.audit.path), 'onboarding.json'),
      });
      await onboard.load();
      const api = consoleApi(
        runtime,
        { version: pkg.version, startedAt, slack: slack !== null, monitoring: monitor !== null },
        investigationLog,
        consoleApprovals,
        consoleChat,
        {
          store: settings,
          people,
          gate: policyGate,
          doctor: () => doctorRows(opts.configPath, ctx, 'console'),
          // After the response is sent, so the page hears that the save worked.
          restart: () => {
            setTimeout(() => {
              if (!kube) {
                restart.abort();
                return;
              }
              // A new pod picks up the new ConfigMap and Secret; this one is stopped.
              ctx.term.out('Restarting the Deployment to apply the new settings.');
              kube.restart(new Date()).catch((error: unknown) => {
                ctx.term.err(
                  `Could not restart the Deployment (${error instanceof Error ? error.message : String(error)}). Run kubectl rollout restart.`,
                );
              });
            }, 300);
          },
        },
        { dashboard, checks, onboard },
      );
      consoleServer = await startConsoleServer({
        port: ctx.consolePort ?? runtime.config.spec.console.port,
        accounts: [
          ...(token ? [{ token, user: { name: 'console', canApprove: false } }] : []),
          ...consoleAccounts,
        ],
        admin: { account: admin, user: { name: ADMIN_USER, canApprove: adminCanApprove } },
        ...api,
        features: { chat: consoleChat !== null },
        sessions,
        ...(ctx.consoleStaticDir ? { staticDir: ctx.consoleStaticDir } : {}),
      });
      ctx.term.out(
        `Console on port ${String(portOf(consoleServer))}: sign in as admin with the password set by init.`,
      );
    }

    ready = true;
    ctx.term.out(
      `Kodra AI Agent is running (${
        [slack ? 'Slack' : '', consoleServer ? 'the console' : ''].filter(Boolean).join(' and ') ||
        'no chat surface'
      }${monitor ? ', monitoring alerts' : ''}${
        checks.schedules.length > 0
          ? `, checks at ${checks.schedules.map((s) => `${s.at} ${s.timezone}`).join(' and ')}`
          : ''
      }${runtime.control.paused ? ', changes paused' : ''}).`,
    );
    // The agent's own metrics (M14), on their own port.
    if (runtime.config.spec.metrics.enabled) {
      metricsServer = await startMetricsServer(
        ctx.metricsPort ?? runtime.config.spec.metrics.port,
        async () => {
          const budget = await runtime.budget().catch(() => null);
          runtime.metrics.setBudget(
            budget?.limit && budget.spent !== null
              ? { remaining: Math.max(0, budget.limit - budget.spent), limit: budget.limit }
              : null,
          );
          return runtime.metrics.render();
        },
      );
    }
    ctx.onReady?.({
      healthPort: portOf(health),
      ...(consoleServer ? { consolePort: portOf(consoleServer) } : {}),
      ...(metricsServer ? { metricsPort: portOf(metricsServer) } : {}),
    });
    await Promise.race([
      waitForStop(ctx),
      new Promise<void>((resolve) => {
        restart.signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      }),
    ]);
    if (restart.signal.aborted) {
      // Settings changed: exit so Docker Compose (restart: unless-stopped) starts it again.
      ctx.term.out('Restarting to apply the new settings.');
      return RESTART_EXIT_CODE;
    }
    ctx.term.out('Stopping.');
    return 0;
  } finally {
    ready = false;
    clearInterval(timer);
    clearInterval(sweepTimer);
    await sweeping;
    checks?.stop();
    await approvals?.cancelAll();
    consoleApprovals.cancelAll();
    await slack?.stop().catch(() => undefined);
    await monitor?.idle();
    await checks?.idle();
    await conversations?.idle();
    consoleChat?.stopAll();
    await consoleChat?.idle();
    await runtime.close();
    if (consoleServer) await closeServer(consoleServer);
    if (metricsServer) await closeServer(metricsServer);
    await closeServer(health);
  }
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

function helloText(runtime: Runtime): string {
  const destructive =
    runtime.config.spec.policy.destructiveActions === 'deny'
      ? 'Destructive actions are blocked.'
      : 'Destructive actions need approval.';
  return [
    `Kodra AI Agent is online (${runtime.config.spec.model.provider}/${runtime.config.spec.model.name}).`,
    ...describeConnectors(runtime).map((l) => `• ${l}`),
    `I ask an approver before any change. ${destructive} Mention me to ask a question.`,
  ].join('\n');
}

/** Why the first Slack post failed, with what to do about it. */
export function slackStartError(error: unknown, channel: string): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  const code = typeof data?.error === 'string' ? data.error : '';
  const fix = 'Fix it in the console or kodra-agent.yaml, then restart. Running without Slack.';
  switch (code) {
    case 'channel_not_found':
    case 'not_in_channel':
      return `Slack cannot post to ${channel}: the channel name is wrong, or the app is not in it. Invite the app to the channel (/invite @your-app) or check the name. ${fix}`;
    case 'is_archived':
      return `Slack cannot post to ${channel}: the channel is archived. ${fix}`;
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return `Slack rejected the bot token (${code}). Copy the Bot User OAuth Token (xoxb-) again from the app's OAuth & Permissions page. ${fix}`;
    case 'missing_scope':
      return `The Slack app is missing a scope it needs (chat:write). Add it, reinstall the app, and copy the new bot token. ${fix}`;
    default:
      return `Slack failed: ${code || (error instanceof Error ? error.message : String(error))}. ${fix}`;
  }
}

/** GET /metrics in the Prometheus text format; nothing else. */
async function startMetricsServer(port: number, render: () => Promise<string>): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
      render().then(
        (body) => {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
        },
        () => {
          res.writeHead(500).end();
        },
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return server;
}

async function startHealthServer(
  ctx: Context,
  isReady: () => boolean,
  unavailable: () => string[],
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else if (req.url === '/readyz') {
      const ok = isReady();
      // Still ready with a connector down: the rest of the agent works. The body says what is missing.
      const missing = ok ? unavailable() : [];
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' })
        .end(
          ok
            ? missing.length
              ? `ready; not available: ${missing.join(', ')}`
              : 'ready'
            : 'starting',
        );
    } else {
      res.writeHead(404).end();
    }
  });
  const port =
    ctx.healthPort ?? (Number(ctx.env['KODRA_AGENT_HEALTH_PORT']) || DEFAULT_HEALTH_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    // Open event streams would otherwise keep the server from closing.
    server.closeAllConnections();
  });
}

function waitForStop(ctx: Context): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.stopSignal) {
      if (ctx.stopSignal.aborted) resolve();
      else
        ctx.stopSignal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      return;
    }
    const done = () => {
      process.off('SIGTERM', done);
      process.off('SIGINT', done);
      resolve();
    };
    process.on('SIGTERM', done);
    process.on('SIGINT', done);
  });
}
