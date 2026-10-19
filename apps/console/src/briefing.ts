import type { DashboardView, OverviewView, RunState, StatusView } from './api.ts';
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

/** One line of the briefing: a message, the page with the detail, and its place in line. */
export interface BriefingItem {
  key: MessageKey;
  vars: Record<string, string | number>;
  to: string | null;
}

export interface BriefingInput {
  status: StatusView | null;
  pending: number;
  overview: OverviewView | null;
  dashboard: DashboardView | null;
}

export interface Briefing {
  /** Things someone should look at, most urgent first. */
  attention: BriefingItem[];
  /** How many there were before the list was cut to `MAX_ITEMS`. */
  total: number;
}

export const MAX_ITEMS = 5;
/** The budget line shows from this share of the monthly budget. */
export const BUDGET_NEAR = 0.8;

/** `.one` for 1, `.other` for anything else. */
function counted(base: string, n: number): MessageKey {
  return `${base}.${n === 1 ? 'one' : 'other'}` as MessageKey;
}

function dashboardTotals(dashboard: DashboardView | null) {
  const totals = { podsFailing: 0, notReady: 0, failedRuns: 0, failingIn: new Set<string>() };
  for (const connector of dashboard?.connectors ?? []) {
    for (const panel of connector.panels) {
      for (const result of panel.results) {
        const data = result.data;
        if (!data) continue;
        if (data.kind === 'pods') {
          totals.podsFailing += data.counts.failing;
          if (data.counts.failing > 0 && result.target) totals.failingIn.add(result.target);
        } else if (data.kind === 'deployments') {
          totals.notReady += Math.max(0, data.total - data.ready);
        } else if (data.kind === 'runs' || data.kind === 'jobs') {
          const counts: Record<RunState, number> = data.counts;
          totals.failedRuns += counts.failed;
        }
      }
    }
  }
  return totals;
}

/**
 * What needs someone, from data the console already has: never the model, so it is
 * instant, free, and says only what the agent's own records and read tools show.
 */
export function briefing({ status, pending, overview, dashboard }: BriefingInput): Briefing {
  const items: BriefingItem[] = [];
  if (status?.paused)
    items.push({ key: 'welcome.paused', vars: { who: status.paused.by }, to: null });
  if (pending > 0) {
    items.push({
      key: counted('welcome.approvals', pending),
      vars: { n: pending },
      to: '/approvals',
    });
  }
  const budget = status?.budget;
  if (budget?.limit && budget.spent !== null) {
    const share = budget.spent / budget.limit;
    if (budget.over || share >= 1) {
      items.push({ key: 'welcome.budgetOver', vars: {}, to: '/usage' });
    } else if (share >= BUDGET_NEAR) {
      items.push({
        key: 'welcome.budgetNear',
        vars: { share: Math.round(share * 100) },
        to: '/usage',
      });
    }
  }
  const totals = dashboardTotals(dashboard);
  if (totals.podsFailing > 0) {
    const where = [...totals.failingIn].sort().join(', ');
    items.push({
      key: counted(where ? 'welcome.podsFailingIn' : 'welcome.podsFailing', totals.podsFailing),
      vars: { n: totals.podsFailing, where },
      to: '/dashboard',
    });
  }
  if (totals.notReady > 0) {
    items.push({
      key: counted('welcome.notReady', totals.notReady),
      vars: { n: totals.notReady },
      to: '/dashboard',
    });
  }
  if (totals.failedRuns > 0) {
    items.push({
      key: counted('welcome.runsFailed', totals.failedRuns),
      vars: { n: totals.failedRuns },
      to: '/dashboard',
    });
  }
  const down = (status?.connectors ?? []).filter((c) => !c.available).map((c) => c.name);
  if (down.length > 0) {
    items.push({
      key: counted('welcome.connectorsDown', down.length),
      vars: { n: down.length, names: down.join(', ') },
      to: '/settings',
    });
  }
  if (overview && overview.investigationsToday > 0) {
    items.push({
      key: counted('welcome.investigations', overview.investigationsToday),
      vars: { n: overview.investigationsToday },
      to: '/investigations',
    });
  }
  return { attention: items.slice(0, MAX_ITEMS), total: items.length };
}

/** The sentence over the list. */
export function headlineFor(total: number): MessageKey {
  if (total === 0) return 'welcome.allQuiet';
  return counted('welcome.needsYou', total);
}
