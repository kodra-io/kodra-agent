import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import pkg from '../../package.json' with { type: 'json' };
import { formatUsage, runTurn } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import { InvestigationLog } from '../console/data.ts';
import { consoleRoutes } from '../console/routes.ts';
import { startConsoleServer } from '../console/server.ts';
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
  const runtime = await startRuntime(opts.configPath, ctx);
  if (!runtime) {
    await closeServer(health);
    return 1;
  }
  unavailable = [...new Set(runtime.host.failures().map((f) => f.displayName))];

  const startedAt = new Date();
  const investigationLog = new InvestigationLog(runtime.config.spec.audit.path, ctx.redactor);
  let consoleServer: Server | null = null;
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

    if (runtime.config.spec.console.enabled) {
      const token = runtime.env[CONSOLE_TOKEN_ENV];
      if (!token) {
        ctx.term.err(
          `The console is off: ${CONSOLE_TOKEN_ENV} is not set. Run \`kodra-agent init\` to create it.`,
        );
      } else {
        consoleServer = await startConsoleServer({
          port: ctx.consolePort ?? runtime.config.spec.console.port,
          token,
          ...(ctx.consoleStaticDir ? { staticDir: ctx.consoleStaticDir } : {}),
          routes: consoleRoutes(
            runtime,
            {
              version: pkg.version,
              startedAt,
              slack: slack !== null,
              monitoring: monitor !== null,
            },
            investigationLog,
          ),
        });
        ctx.term.out(
          `Console on port ${String(portOf(consoleServer))}: sign in with ${CONSOLE_TOKEN_ENV}.`,
        );
      }
    }

    ready = true;
    ctx.term.out(
      `Kodra AI Agent is running (${slack ? 'Slack' : 'no chat surface'}${monitor ? ', monitoring alerts' : ''}).`,
    );
    ctx.onReady?.({
      healthPort: portOf(health),
      ...(consoleServer ? { consolePort: portOf(consoleServer) } : {}),
    });
    await waitForStop(ctx);
    ctx.term.out('Stopping.');
    return 0;
  } finally {
    ready = false;
    clearInterval(timer);
    await approvals?.cancelAll();
    await slack?.stop().catch(() => undefined);
    await monitor?.idle();
    await conversations?.idle();
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
  return new Promise((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
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
