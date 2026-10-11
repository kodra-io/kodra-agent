import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { formatUsage, runTurn } from '../agent.ts';
import { consoleApproverTokenEnv, isConsoleApprover } from '@kodra-agent/schema';
import { fanOut, type ApprovalChannel, type SettleableChannel } from '../approvals.ts';
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
import { consoleApi } from '../console/routes.ts';
import { SettingsStore } from '../console/settings.ts';
import { SessionRegistry, startConsoleServer, type ConsoleAccount } from '../console/server.ts';
import { CONSOLE_TOKEN_ENV } from '../console/token.ts';
import type { Context } from '../context.ts';
import { fetchFiringAlerts } from '../monitoring/alerts.ts';
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
  const runtime = await startRuntime(configPath, ctx);
  if (!runtime) {
    await closeServer(health);
    return 1;
  }
  unavailable = [...new Set(runtime.host.failures().map((f) => f.displayName))];

  const startedAt = new Date();
  const restart = new AbortController();
  const investigationLog = new InvestigationLog(runtime.config.spec.audit.path, ctx.redactor);
  let consoleServer: Server | null = null;
  const consoleOn = runtime.config.spec.console.enabled;
  const consoleApprovals = new ConsoleApprovals({ audit: runtime.audit });
  let consoleChat: ConsoleChat | null = null;
  // Console approvers who can sign in: each needs their own token.
  const consoleAccounts: ConsoleAccount[] = [];
  if (consoleOn) {
    for (const entry of runtime.config.spec.policy.approvals.approvers.filter(isConsoleApprover)) {
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
    consoleAccounts.length > 0 ? [consoleApprovals.channel] : [];
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
  let monitor: AlertMonitor | null = null;
  try {
    const slackInput = runtime.inputs.find((i) => i.component.id === 'slack');
    let channelId: string | null = null;
    let api: SlackApi | null = null;
    if (slackInput) {
      const { botToken, appToken } = slackInput.secrets;
      if (!botToken || !appToken) {
        ctx.term.err('Slack needs both the bot token and the app token. Run `kodra-agent init`.');
        return 1;
      }
      slack = (ctx.slackConnection ?? boltSlack)(botToken, appToken);
      api = slack.api;
      const configured = runtime.config.spec.policy.approvals.approvers;
      const users = await api.listUsers().catch(() => {
        ctx.term.err('Could not list Slack users (needs users:read); only user ids can approve.');
        return [];
      });
      const approvers = resolveApprovers(configured, users);
      for (const entry of approvers.unresolved) {
        ctx.term.err(`Approver ${entry} matches no single Slack user; use their user id (U…).`);
      }
      const hello = await api.postMessage({
        channel: String(slackInput.component.settings['channel']),
        text: ctx.redactor.redact(helloText(runtime)),
      });
      channelId = hello.channel;
      approvals = new SlackApprovals({
        api,
        audit: runtime.audit,
        redactor: ctx.redactor,
        approverIds: approvers.ids,
      });
      conversations = new SlackConversations({
        api,
        approvals,
        redactor: ctx.redactor,
        channelId,
        approverIds: approvers.ids,
        deps: runtime.deps,
        alsoAsk: consoleChannels,
        gate,
      });
      const conv = conversations;
      const appr = approvals;
      await slack.start({
        onMention: (m) => conv.onMention(m),
        onDirectMessage: (m) => conv.onDirectMessage(m),
        onAction: async (a) => {
          await appr.handleAction(a);
        },
      });
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
    if (prometheus) {
      const settings = prometheus.component.settings;
      const intervalMs = Number(settings['pollIntervalSeconds'] ?? 60) * 1000;
      monitor = new AlertMonitor({
        limits: runtime.config.spec.monitoring,
        fetchAlerts: () =>
          fetchFiringAlerts({
            fetch: ctx.fetch,
            timeoutMs: ctx.probeTimeoutMs,
            alertmanagerUrl:
              typeof settings['alertmanagerUrl'] === 'string'
                ? settings['alertmanagerUrl']
                : undefined,
            prometheusUrl: typeof settings['url'] === 'string' ? settings['url'] : undefined,
            token: prometheus.secrets['bearerToken'],
          }),
        investigate: async (alert) => {
          const deps = { ...runtime.deps(refuseAll), readOnly: true, actor: 'monitor' };
          const result = await runTurn(
            deps,
            [],
            investigationPrompt(alert),
            `alert-${randomUUID().slice(0, 8)}`,
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

    if (consoleOn) {
      const token = runtime.env[CONSOLE_TOKEN_ENV];
      if (!token) {
        ctx.term.err(
          `The console is off: ${CONSOLE_TOKEN_ENV} is not set. Run \`kodra-agent init\` to create it.`,
        );
      } else {
        if (runtime.config.spec.console.chat) {
          // A console question asks for approval in the console and in Slack's channel.
          const slackChannel =
            approvals && channelId ? [approvals.channelFor(channelId, undefined)] : [];
          consoleChat = new ConsoleChat({
            deps: runtime.deps,
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
        });
        // Sign-outs are kept next to the audit log, so a restart does not undo them.
        const sessions = new SessionRegistry({
          path: join(dirname(runtime.config.spec.audit.path), 'console-sessions.json'),
        });
        await sessions.load();
        const people = new People({ store: settings, sessions, env: runtime.env });
        const api = consoleApi(
          runtime,
          { version: pkg.version, startedAt, slack: slack !== null, monitoring: monitor !== null },
          investigationLog,
          consoleApprovals,
          consoleChat,
          {
            store: settings,
            people,
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
        );
        consoleServer = await startConsoleServer({
          port: ctx.consolePort ?? runtime.config.spec.console.port,
          accounts: [{ token, user: { name: 'console', canApprove: false } }, ...consoleAccounts],
          ...api,
          features: { chat: consoleChat !== null },
          sessions,
          ...(ctx.consoleStaticDir ? { staticDir: ctx.consoleStaticDir } : {}),
        });
        ctx.term.out(
          `Console on port ${String(portOf(consoleServer))}: sign in with ${CONSOLE_TOKEN_ENV}.`,
        );
      }
    }

    ready = true;
    ctx.term.out(
      `Kodra AI Agent is running (${
        [slack ? 'Slack' : '', consoleServer ? 'the console' : ''].filter(Boolean).join(' and ') ||
        'no chat surface'
      }${monitor ? ', monitoring alerts' : ''}${runtime.control.paused ? ', changes paused' : ''}).`,
    );
    ctx.onReady?.({
      healthPort: portOf(health),
      ...(consoleServer ? { consolePort: portOf(consoleServer) } : {}),
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
    await approvals?.cancelAll();
    consoleApprovals.cancelAll();
    await slack?.stop().catch(() => undefined);
    await monitor?.idle();
    await conversations?.idle();
    consoleChat?.stopAll();
    await consoleChat?.idle();
    await runtime.close();
    if (consoleServer) await closeServer(consoleServer);
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
