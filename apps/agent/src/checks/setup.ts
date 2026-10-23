import { verifyAuditChain } from '../audit.ts';
import type { Context } from '../context.ts';
import { ConnectorDashboard } from '../dashboard.ts';
import { fetchFiringAlerts, type Alert } from '../monitoring/alerts.ts';
import type { Runtime } from '../runtime.ts';
import { CheckRunner } from './runner.ts';
import { ChecksState } from './state.ts';

/** The read-only dashboard over the enabled connectors, shared by the console and the checks. */
export function connectorDashboard(runtime: Runtime): ConnectorDashboard {
  // The dashboard only reads, so it never asks for approval.
  const deps = runtime.deps({
    request: () => Promise.resolve({ decision: 'denied', by: 'dashboard' }),
  });
  return new ConnectorDashboard({
    host: deps.host,
    redactor: deps.redactor,
    policy: { destructiveActions: deps.policy.destructiveActions, self: deps.policy.self ?? null },
    manifests: runtime.inputs.map((i) => i.component.manifest),
  });
}

/** Firing alerts from the Prometheus connector's Alertmanager or Prometheus, if it is on. */
export function alertSource(runtime: Runtime, ctx: Context): (() => Promise<Alert[]>) | undefined {
  const prometheus = runtime.inputs.find((i) => i.component.id === 'prometheus');
  if (!prometheus) return undefined;
  const settings = prometheus.component.settings;
  return () =>
    fetchFiringAlerts({
      fetch: ctx.fetch,
      timeoutMs: ctx.probeTimeoutMs,
      alertmanagerUrl:
        typeof settings['alertmanagerUrl'] === 'string' ? settings['alertmanagerUrl'] : undefined,
      prometheusUrl: typeof settings['url'] === 'string' ? settings['url'] : undefined,
      token: prometheus.secrets['bearerToken'],
    });
}

/** Default branches the source connectors looked up, by lowercase repo or project. */
function defaultBranchLookup(runtime: Runtime): (target: string) => string | null | undefined {
  const branches = new Map<string, string | null>();
  for (const input of runtime.inputs) {
    for (const [repo, branch] of input.defaultBranches ?? []) branches.set(repo, branch);
  }
  return (target) => branches.get(target.toLowerCase());
}

/** A check runner wired to the runtime: its dashboard, alerts, audit log, and spec.checks. */
export async function checkRunner(
  runtime: Runtime,
  ctx: Context,
  opts: {
    dashboard?: ConnectorDashboard;
    post: (text: string) => Promise<void>;
    pendingApprovals?: () => number;
    now?: () => Date;
  },
): Promise<CheckRunner> {
  const auditPath = runtime.config.spec.audit.path;
  const state = new ChecksState(auditPath);
  await state.load();
  const dashboard = opts.dashboard ?? connectorDashboard(runtime);
  return new CheckRunner({
    dashboard: () => dashboard.view(),
    alerts: alertSource(runtime, ctx),
    self: async () => ({
      chain: await verifyAuditChain(auditPath),
      budget: await runtime.budget().catch(() => null),
      pendingApprovals: opts.pendingApprovals?.() ?? 0,
    }),
    rules: { defaultBranch: defaultBranchLookup(runtime) },
    state,
    audit: runtime.audit,
    redactor: ctx.redactor,
    post: opts.post,
    schedules: runtime.config.spec.checks.schedules,
    quietWhenClean: runtime.config.spec.checks.quietWhenClean,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
