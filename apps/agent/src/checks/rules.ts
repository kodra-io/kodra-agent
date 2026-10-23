import type { BudgetState } from '../budget.ts';
import type { ChainCheck } from '../audit.ts';
import type { DashboardResult, PanelData, RunsData } from '../dashboard.ts';
import type { Alert } from '../monitoring/alerts.ts';

/**
 * The checks (M27): fixed rules over what the dashboard already reads (pods, deployments,
 * warnings, pipelines, jobs, databases), the firing alerts, and the agent's own state. No
 * model and no new reads: a check only sees parsed, redacted fields.
 */
export type CheckId =
  'pods' | 'deployments' | 'warnings' | 'pipelines' | 'jobs' | 'databases' | 'alerts' | 'agent';

export const CHECK_TITLES: Record<CheckId, string> = {
  pods: 'Pods',
  deployments: 'Deployments',
  warnings: 'Warnings',
  pipelines: 'Pipelines',
  jobs: 'Jobs',
  databases: 'Databases',
  alerts: 'Alerts',
  agent: 'The agent',
};

export interface Finding {
  /** Stable across runs while the problem lasts, so the digest can tell new from ongoing. */
  id: string;
  check: CheckId;
  severity: 'critical' | 'warning';
  title: string;
  /** Where it is: a namespace, repo, or database. */
  where: string;
  url?: string;
}

/** A card that could not be read, so its check did not run there. */
export interface CheckGap {
  check: CheckId;
  where: string;
  reason: string;
}

export interface Observations {
  findings: Finding[];
  gaps: CheckGap[];
  /** The checks that had something to look at. */
  ran: CheckId[];
}

/** Restarts at which a running pod counts as a restart loop. */
export const RESTART_LOOP = 5;
/** Warning events per namespace in the digest; the rest are counted, not listed. */
const MAX_WARNINGS = 5;

const VIEW_CHECK: Record<PanelData['kind'], CheckId> = {
  pods: 'pods',
  deployments: 'deployments',
  events: 'warnings',
  runs: 'pipelines',
  jobs: 'jobs',
  workload: 'databases',
  database: 'databases',
};

export interface RuleOptions {
  /** The default branch of a repo or project, when known (from the source connector). */
  defaultBranch?: (target: string) => string | null | undefined;
}

/** Findings from one dashboard read. */
export function dashboardFindings(
  dashboard: DashboardResult,
  opts: RuleOptions = {},
): Observations {
  const findings: Finding[] = [];
  const gaps: CheckGap[] = [];
  const ran = new Set<CheckId>();
  for (const connector of dashboard.connectors) {
    for (const panel of connector.panels) {
      for (const result of panel.results) {
        const where = result.target ?? connector.displayName;
        if (!result.data) {
          const check = VIEW_CHECK[panel.view];
          gaps.push({ check, where, reason: result.error ?? 'no data' });
          continue;
        }
        const data = result.data;
        ran.add(VIEW_CHECK[data.kind]);
        const key = `${connector.id}:${panel.id}:${where}`;
        findings.push(...findingsOf(data, key, where, opts));
      }
    }
  }
  return { findings, gaps, ran: [...ran] };
}

function findingsOf(data: PanelData, key: string, where: string, opts: RuleOptions): Finding[] {
  switch (data.kind) {
    case 'pods':
      return data.pods.flatMap((p): Finding[] => {
        const id = `${key}:${p.name}`;
        if (p.status !== 'Running' && p.status !== 'Succeeded' && p.status !== 'Completed') {
          const pending = p.status === 'Pending' || p.status === 'ContainerCreating';
          return [
            {
              id,
              check: 'pods',
              severity: pending ? 'warning' : 'critical',
              title: `Pod ${p.name} is ${p.status}${p.restarts > 0 ? ` (${String(p.restarts)} restarts)` : ''}`,
              where,
            },
          ];
        }
        if (p.restarts >= RESTART_LOOP) {
          return [
            {
              id,
              check: 'pods',
              severity: 'warning',
              title: `Pod ${p.name} restarted ${String(p.restarts)} times`,
              where,
            },
          ];
        }
        const [ready = 0, total = 0] = p.ready.split('/').map(Number);
        return p.status === 'Running' && ready < total
          ? [
              {
                id,
                check: 'pods',
                severity: 'warning',
                title: `Pod ${p.name} is not ready (${p.ready})`,
                where,
              },
            ]
          : [];
      });
    case 'deployments':
      return data.deployments
        .filter((d) => d.ready < d.desired)
        .map((d) => ({
          id: `${key}:${d.name}`,
          check: 'deployments' as const,
          severity: d.ready === 0 ? ('critical' as const) : ('warning' as const),
          title: `Deployment ${d.name} has ${String(d.ready)} of ${String(d.desired)} replicas ready`,
          where,
        }));
    case 'events': {
      const listed = data.warnings.slice(0, MAX_WARNINGS).map((w) => ({
        id: `${key}:${w.reason}:${w.object}`,
        check: 'warnings' as const,
        severity: 'warning' as const,
        title: `${w.reason} on ${w.object}${w.count > 1 ? ` (${String(w.count)} times)` : ''}: ${w.message}`,
        where,
      }));
      const more = data.warnings.length - listed.length;
      return more > 0
        ? [
            ...listed,
            {
              id: `${key}:more`,
              check: 'warnings',
              severity: 'warning',
              title: `${String(more)} more warning${more === 1 ? '' : 's'}`,
              where,
            },
          ]
        : listed;
    }
    case 'runs':
      return failingPipelines(data, key, where, opts.defaultBranch?.(where));
    case 'jobs':
      return data.jobs
        .filter((j) => j.state === 'failed')
        .map((j) => ({
          id: `${key}:${j.name}`,
          check: 'jobs' as const,
          severity: 'warning' as const,
          title: `Job ${j.name} failed (${j.status})`,
          where,
          ...(j.url ? { url: j.url } : {}),
        }));
    case 'workload':
      return data.state === 'ok'
        ? []
        : [
            {
              id: `${key}:${data.name}`,
              check: 'databases',
              severity: data.state === 'down' ? 'critical' : 'warning',
              title: `Database ${data.name} is ${data.state} (${String(data.ready)} of ${String(data.total)} pods ready)`,
              where,
            },
          ];
    case 'database':
      return data.state === 'ok'
        ? []
        : [
            {
              id: `${key}:${data.name}`,
              check: 'databases',
              severity: data.state === 'down' ? 'critical' : 'warning',
              title: `Database ${data.name} is ${data.state}${data.reasons.length > 0 ? `: ${data.reasons.join('; ')}` : ''}`,
              where,
            },
          ];
  }
}

/**
 * A pipeline is failing when its latest run on the default branch failed. Without a known
 * default branch, main and master are taken as default.
 */
function failingPipelines(
  data: RunsData,
  key: string,
  where: string,
  defaultBranch: string | null | undefined,
): Finding[] {
  const isDefault = (ref: string) =>
    defaultBranch ? ref === defaultBranch : ref === 'main' || ref === 'master';
  const latest = new Map<string, RunsData['runs'][number]>();
  for (const run of data.runs) {
    if (!isDefault(run.ref)) continue;
    const name = run.name ?? '';
    const seen = latest.get(name);
    if (!seen || run.at > seen.at) latest.set(name, run);
  }
  return [...latest.entries()]
    .filter(([, run]) => run.state === 'failed')
    .map(([name, run]) => ({
      id: `${key}:${name}:${run.ref}`,
      check: 'pipelines' as const,
      severity: 'warning' as const,
      title: `${name ? `${name} on ` : 'The pipeline on '}${run.ref} is failing (${run.status})`,
      where,
      ...(run.url ? { url: run.url } : {}),
    }));
}

/** Every firing alert. */
export function alertFindings(alerts: readonly Alert[]): Finding[] {
  return alerts.map((a) => ({
    id: `alert:${a.fingerprint}`,
    check: 'alerts' as const,
    severity: /^(critical|page|error)$/i.test(a.severity) ? 'critical' : 'warning',
    title: `${a.name}${a.annotations['summary'] ? `: ${a.annotations['summary']}` : ''}`,
    where: a.labels['namespace'] ?? a.labels['instance'] ?? a.labels['job'] ?? 'alerts',
  }));
}

/** Share of the monthly budget at which spend is worth a mention. */
export const BUDGET_WARNING = 0.8;

/** The agent's own state: an intact audit log, spend, approvals nobody has answered. */
export function agentFindings(self: {
  chain: ChainCheck;
  budget: BudgetState | null;
  pendingApprovals: number;
}): Finding[] {
  const out: Finding[] = [];
  if (!self.chain.ok) {
    out.push({
      id: 'agent:audit-chain',
      check: 'agent',
      severity: 'critical',
      title: `The audit log failed its check: ${self.chain.problem ?? 'the chain is broken'}`,
      where: 'audit log',
    });
  }
  const { budget } = self;
  if (budget?.limit && budget.spent !== null && budget.spent >= budget.limit * BUDGET_WARNING) {
    out.push({
      id: `agent:budget:${budget.month}`,
      check: 'agent',
      severity: budget.over ? 'critical' : 'warning',
      title: budget.over
        ? `The monthly budget of $${budget.limit.toFixed(2)} is used up`
        : `About $${budget.spent.toFixed(2)} of the $${budget.limit.toFixed(2)} monthly budget is used`,
      where: 'usage',
    });
  }
  if (self.pendingApprovals > 0) {
    out.push({
      id: 'agent:approvals',
      check: 'agent',
      severity: 'warning',
      title: `${String(self.pendingApprovals)} approval request${self.pendingApprovals === 1 ? '' : 's'} waiting for an answer`,
      where: 'approvals',
    });
  }
  return out;
}
