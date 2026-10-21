import type { DashboardView, OverviewView, PanelResult, StatusView, TargetResult } from './api.ts';
import type { MessageKey } from './i18n.tsx';

/** Morning until noon, afternoon until 6 pm, evening after that (and before 5 am). */
export function greetingFor(hour: number): MessageKey {
  if (hour >= 5 && hour < 12) return 'welcome.morning';
  if (hour >= 12 && hour < 18) return 'welcome.afternoon';
  return 'welcome.evening';
}

/** `console:omar` is Omar. The shared token and the built-in admin have no name to greet. */
export function nameOf(user: string): string | null {
  const match = /^console:(.+)$/.exec(user);
  const name = match?.[1];
  if (!name || name === 'admin') return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** How bad a line is: something broken, a decision someone owes, a risk, or a note. */
export type Severity = 'critical' | 'action' | 'warning' | 'info';
const SEVERITY_ORDER: readonly Severity[] = ['critical', 'action', 'warning', 'info'];

/** One line of the attention queue: a message, its severity, and the page with the detail. */
export interface BriefingItem {
  key: MessageKey;
  vars: Record<string, string | number>;
  severity: Severity;
  to: string | null;
}

export interface BriefingInput {
  status: StatusView | null;
  pending: number;
  overview: OverviewView | null;
  dashboard: DashboardView | null;
}

/** The whole picture: `critical` when anything is broken, `degraded` when anything needs someone. */
export type Posture = 'nominal' | 'degraded' | 'critical';

export interface Briefing {
  posture: Posture;
  /** What needs someone, worst first. */
  attention: BriefingItem[];
  /** How many there were before the list was cut to `MAX_ITEMS`. */
  total: number;
}

export const MAX_ITEMS = 6;
/** The budget line shows from this share of the monthly budget. */
export const BUDGET_NEAR = 0.8;

/** `.one` for 1, `.other` for anything else. */
function counted(base: string, n: number): MessageKey {
  return `${base}.${n === 1 ? 'one' : 'other'}` as MessageKey;
}

/** The dashboard's numbers added up across connectors and targets. */
export interface Totals {
  podsRunning: number;
  podsFailing: number;
  podsTotal: number;
  deploymentsReady: number;
  deploymentsTotal: number;
  runsPassed: number;
  runsFailed: number;
  runsRunning: number;
  /** Namespaces with a failing pod. */
  failingIn: string[];
  /**
   * Every watched database, wherever it runs: a Kubernetes workload (`namespace/name`) or one
   * the Databases connector connects to (by name); `unknown` when its card could not be read.
   */
  databases: Database[];
  /** Whether any card had numbers at all. */
  seen: { pods: boolean; deployments: boolean; runs: boolean; databases: boolean };
}

export interface Database {
  target: string;
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  /** A Kubernetes workload's pods, or a connection the agent makes to the database itself. */
  source: 'kubernetes' | 'connection';
  /** Pods (Kubernetes only). */
  ready: number;
  total: number;
  restarts: number;
  /** Connections in use (a connection only, when the user may read it). */
  connections: { used: number; max: number } | null;
}

/** The views that report databases: a Kubernetes workload, or the Databases connector. */
const DATABASE_VIEWS: readonly PanelResult['view'][] = ['workload', 'database'];

function databaseOf(view: PanelResult['view'], result: TargetResult): Database {
  const data = result.data;
  if (data?.kind === 'workload') {
    return {
      target: result.target ?? data.name,
      state: data.state,
      source: 'kubernetes',
      ready: data.ready,
      total: data.total,
      restarts: data.restarts,
      connections: null,
    };
  }
  if (data?.kind === 'database') {
    return {
      target: result.target ?? data.name,
      state: data.state,
      source: 'connection',
      ready: 0,
      total: 0,
      restarts: 0,
      connections: data.connections,
    };
  }
  return {
    target: result.target ?? '',
    state: 'unknown',
    source: view === 'workload' ? 'kubernetes' : 'connection',
    ready: 0,
    total: 0,
    restarts: 0,
    connections: null,
  };
}

export function totalsOf(dashboard: DashboardView | null): Totals {
  const t: Totals = {
    podsRunning: 0,
    podsFailing: 0,
    podsTotal: 0,
    deploymentsReady: 0,
    deploymentsTotal: 0,
    runsPassed: 0,
    runsFailed: 0,
    runsRunning: 0,
    failingIn: [],
    databases: [],
    seen: { pods: false, deployments: false, runs: false, databases: false },
  };
  const failingIn = new Set<string>();
  for (const connector of dashboard?.connectors ?? []) {
    for (const panel of connector.panels) {
      for (const result of panel.results) {
        const data = result.data;
        if (DATABASE_VIEWS.includes(panel.view)) {
          t.seen.databases = true;
          t.databases.push(databaseOf(panel.view, result));
          continue;
        }
        if (!data) continue;
        if (data.kind === 'pods') {
          const c = data.counts;
          t.seen.pods = true;
          t.podsRunning += c.running;
          t.podsFailing += c.failing;
          t.podsTotal += c.running + c.pending + c.failing;
          if (c.failing > 0 && result.target) failingIn.add(result.target);
        } else if (data.kind === 'deployments') {
          t.seen.deployments = true;
          t.deploymentsReady += data.ready;
          t.deploymentsTotal += data.total;
        } else if (data.kind === 'runs' || data.kind === 'jobs') {
          t.seen.runs = true;
          t.runsPassed += data.counts.passed;
          t.runsFailed += data.counts.failed;
          t.runsRunning += data.counts.running;
        }
      }
    }
  }
  t.failingIn = [...failingIn].sort();
  return t;
}

/** Pipeline runs that started today, in the viewer's time zone. */
export interface RunsToday {
  ran: number;
  passed: number;
  failed: number;
  running: number;
  /** A project listed a full page of today's runs: there may be more than counted. */
  atLeast: boolean;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export function runsToday(dashboard: DashboardView | null, now: Date): RunsToday | null {
  const today: RunsToday = { ran: 0, passed: 0, failed: 0, running: 0, atLeast: false };
  let seen = false;
  for (const connector of dashboard?.connectors ?? []) {
    for (const panel of connector.panels) {
      for (const { data } of panel.results) {
        if (data?.kind !== 'runs') continue;
        seen = true;
        const recent = data.recent;
        const own = recent.filter((r) => {
          const at = new Date(r.at);
          return !Number.isNaN(at.getTime()) && sameDay(at, now);
        });
        today.ran += own.length;
        for (const r of own) {
          if (r.state === 'passed') today.passed += 1;
          else if (r.state === 'failed') today.failed += 1;
          else if (r.state === 'running') today.running += 1;
        }
        // Every listed run is from today and the page was full: older ones were cut off.
        if (data.full && recent.length > 0 && own.length === recent.length) today.atLeast = true;
      }
    }
  }
  return seen ? today : null;
}

/**
 * What needs someone, from data the console already has: never the model, so it is
 * instant, free, and says only what the agent's own records and read tools show.
 */
export function briefing({ status, pending, overview, dashboard }: BriefingInput): Briefing {
  const items: BriefingItem[] = [];
  const add = (item: BriefingItem) => items.push(item);
  if (status?.paused) {
    add({ key: 'welcome.paused', vars: { who: status.paused.by }, severity: 'warning', to: null });
  }
  if (pending > 0) {
    add({
      key: counted('welcome.approvals', pending),
      vars: { n: pending },
      severity: 'action',
      to: '/approvals',
    });
  }
  const budget = status?.budget;
  if (budget?.limit && budget.spent !== null) {
    const share = budget.spent / budget.limit;
    if (budget.over || share >= 1) {
      add({ key: 'welcome.budgetOver', vars: {}, severity: 'critical', to: '/usage' });
    } else if (share >= BUDGET_NEAR) {
      add({
        key: 'welcome.budgetNear',
        vars: { share: Math.round(share * 100) },
        severity: 'warning',
        to: '/usage',
      });
    }
  }
  const t = totalsOf(dashboard);
  if (t.podsFailing > 0) {
    const where = t.failingIn.join(', ');
    add({
      key: counted(where ? 'welcome.podsFailingIn' : 'welcome.podsFailing', t.podsFailing),
      vars: { n: t.podsFailing, where },
      severity: 'critical',
      to: '/dashboard',
    });
  }
  const notReady = Math.max(0, t.deploymentsTotal - t.deploymentsReady);
  if (notReady > 0) {
    add({
      key: counted('welcome.notReady', notReady),
      vars: { n: notReady },
      severity: 'warning',
      to: '/dashboard',
    });
  }
  if (t.runsFailed > 0) {
    add({
      key: counted('welcome.runsFailed', t.runsFailed),
      vars: { n: t.runsFailed },
      severity: 'warning',
      to: '/dashboard',
    });
  }
  const dbDown = t.databases.filter((d) => d.state === 'down').map((d) => d.target);
  if (dbDown.length > 0) {
    add({
      key: counted('welcome.databasesDown', dbDown.length),
      vars: { n: dbDown.length, names: dbDown.join(', ') },
      severity: 'critical',
      to: '/dashboard',
    });
  }
  const dbOff = t.databases
    .filter((d) => d.state === 'degraded' || d.state === 'unknown')
    .map((d) => d.target);
  if (dbOff.length > 0) {
    add({
      key: counted('welcome.databasesDegraded', dbOff.length),
      vars: { n: dbOff.length, names: dbOff.join(', ') },
      severity: 'warning',
      to: '/dashboard',
    });
  }
  const down = (status?.connectors ?? []).filter((c) => !c.available).map((c) => c.name);
  if (down.length > 0) {
    add({
      key: counted('welcome.connectorsDown', down.length),
      vars: { n: down.length, names: down.join(', ') },
      severity: 'critical',
      to: '/settings',
    });
  }
  if (overview && overview.investigationsToday > 0) {
    add({
      key: counted('welcome.investigations', overview.investigationsToday),
      vars: { n: overview.investigationsToday },
      severity: 'info',
      to: '/investigations',
    });
  }
  // Worst first; within a severity, the order above.
  const ranked = items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.item.severity) - SEVERITY_ORDER.indexOf(b.item.severity) ||
        a.i - b.i,
    )
    .map(({ item }) => item);
  const posture: Posture = ranked.some((i) => i.severity === 'critical')
    ? 'critical'
    : ranked.some((i) => i.severity !== 'info')
      ? 'degraded'
      : 'nominal';
  return { posture, attention: ranked.slice(0, MAX_ITEMS), total: ranked.length };
}

/** One connected system on the status board. */
export interface SystemState {
  id: string;
  name: string;
  state: 'ok' | 'warn' | 'down';
  metric: { key: MessageKey; vars: Record<string, string | number> };
}

/**
 * Each connector's light (down when it did not start, amber when its cards show trouble),
 * then one per listed database.
 */
export function systemsOf(status: StatusView, dashboard: DashboardView | null): SystemState[] {
  const databases = totalsOf(dashboard).databases.map((d): SystemState => ({
    id: `db:${d.target}`,
    name: d.target,
    state: d.state === 'ok' ? 'ok' : d.state === 'down' ? 'down' : 'warn',
    metric: databaseMetric(d),
  }));
  return [...connectorsOf(status, dashboard), ...databases];
}

function databaseMetric(d: Database): SystemState['metric'] {
  if (d.state === 'unknown') return { key: 'welcome.sys.unreadable', vars: {} };
  if (d.source === 'connection') {
    if (d.state === 'down') return { key: 'welcome.sys.dbDown', vars: {} };
    return d.connections
      ? { key: 'welcome.sys.dbConnections', vars: { ...d.connections } }
      : { key: 'welcome.sys.online', vars: {} };
  }
  return d.total === 0
    ? { key: 'welcome.sys.dbNoPods', vars: {} }
    : { key: 'welcome.sys.db', vars: { ready: d.ready, total: d.total, restarts: d.restarts } };
}

function connectorsOf(status: StatusView, dashboard: DashboardView | null): SystemState[] {
  return status.connectors.map((c) => {
    if (!c.available) {
      return {
        id: c.id,
        name: c.name,
        state: 'down',
        metric: { key: 'welcome.sys.offline', vars: {} },
      };
    }
    const own = dashboard?.connectors.find((d) => d.id === c.id);
    if (!own) {
      return {
        id: c.id,
        name: c.name,
        state: 'ok',
        metric: { key: 'welcome.sys.online', vars: {} },
      };
    }
    // Databases have their own lights.
    const cards = { ...own, panels: own.panels.filter((p) => !DATABASE_VIEWS.includes(p.view)) };
    const t = totalsOf({ updatedAt: '', connectors: [cards] });
    const unreadable = cards.panels.some((p) => p.results.some((r) => r.error));
    const trouble =
      t.podsFailing > 0 ||
      t.runsFailed > 0 ||
      t.deploymentsReady < t.deploymentsTotal ||
      unreadable;
    const metric: SystemState['metric'] = t.seen.pods
      ? { key: 'welcome.sys.pods', vars: { up: t.podsRunning, total: t.podsTotal } }
      : t.seen.runs
        ? { key: 'welcome.sys.runs', vars: { failed: t.runsFailed, passed: t.runsPassed } }
        : unreadable
          ? { key: 'welcome.sys.unreadable', vars: {} }
          : { key: 'welcome.sys.online', vars: {} };
    return { id: c.id, name: c.name, state: trouble ? 'warn' : 'ok', metric };
  });
}
