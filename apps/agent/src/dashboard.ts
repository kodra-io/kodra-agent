import type { DashboardPanel, DashboardView, LocalizedText, Manifest } from '@kodra-agent/schema';
import { parse as parseYaml } from 'yaml';
import { policyInputFor } from './agent.ts';
import type { ConnectorHost, HostedTool } from './mcp/host.ts';
import { decide, inList, type SelfTarget } from './policy.ts';
import type { Redactor } from './redactor.ts';

/**
 * The console dashboard: what each connector can see right now (pods, deployments, warnings,
 * pipelines). Each card is one read tool from the connector's manifest, called without the
 * model, through the same policy check as the agent's calls; output is redacted before it is
 * parsed, and only parsed fields leave here. Not audited: nothing changes and no model is
 * involved (docs/console.md). Refreshed at most once a minute, whoever is looking.
 */

export const DASHBOARD_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 20_000;
/** Targets (namespaces, projects, repos) per card. */
const MAX_TARGETS = 10;
const MAX_ROWS = 8;
const MAX_TEXT = 300;

export type PodState = 'running' | 'pending' | 'failing' | 'completed';

export interface PodsData {
  kind: 'pods';
  counts: Record<PodState, number>;
  /** Failing pods first, then the ones that restart most. */
  pods: { namespace: string; name: string; status: string; ready: string; restarts: number }[];
}

export interface DeploymentsData {
  kind: 'deployments';
  ready: number;
  total: number;
  deployments: { namespace: string; name: string; ready: number; desired: number }[];
}

export interface EventsData {
  kind: 'events';
  warnings: { reason: string; object: string; message: string; at: string; count: number }[];
}

export type RunState = 'passed' | 'failed' | 'running' | 'other';

export interface RunsData {
  kind: 'runs';
  counts: Record<RunState, number>;
  runs: {
    id: string;
    name: string | null;
    ref: string;
    state: RunState;
    status: string;
    url: string | null;
    at: string;
  }[];
}

export interface JobsData {
  kind: 'jobs';
  counts: Record<RunState, number>;
  /** Failed first, then running, then the rest; by name. */
  jobs: { name: string; state: RunState; status: string; url: string | null }[];
}

export type PanelData = PodsData | DeploymentsData | EventsData | RunsData | JobsData;

export interface TargetResult {
  /** The namespace, project, or repo; null for a card without forEach. */
  target: string | null;
  data?: PanelData;
  error?: string;
}

export interface PanelResult {
  id: string;
  title: LocalizedText;
  view: DashboardView['kind'];
  results: TargetResult[];
  /** Why the card has nothing to show, like no namespaces listed. */
  note?: 'no-targets' | 'unavailable';
}

export interface DashboardResult {
  updatedAt: string;
  connectors: { id: string; displayName: string; panels: PanelResult[] }[];
}

export interface DashboardDeps {
  host: Pick<ConnectorHost, 'get' | 'call'>;
  redactor: Redactor;
  policy: { destructiveActions: 'deny' | 'require-approval'; self: SelfTarget | null };
  /** The enabled connectors' manifests, in config order. */
  manifests: readonly Manifest[];
  now?: () => number;
}

export class ConnectorDashboard {
  private readonly deps: DashboardDeps;
  private readonly now: () => number;
  private cached: { at: number; result: DashboardResult } | null = null;
  private inFlight: Promise<DashboardResult> | null = null;

  constructor(deps: DashboardDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Whether any enabled connector has dashboard cards. */
  get hasPanels(): boolean {
    return this.deps.manifests.some((m) => (m.dashboard ?? []).length > 0);
  }

  async view(): Promise<DashboardResult> {
    if (this.cached && this.now() - this.cached.at < DASHBOARD_TTL_MS) return this.cached.result;
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<DashboardResult> {
    const connectors = await Promise.all(
      this.deps.manifests
        .filter((m) => (m.dashboard ?? []).length > 0)
        .map(async (m) => ({
          id: m.id,
          displayName: m.displayName,
          panels: await Promise.all((m.dashboard ?? []).map((p) => this.panel(m.id, p))),
        })),
    );
    const result = { updatedAt: new Date(this.now()).toISOString(), connectors };
    this.cached = { at: this.now(), result };
    return result;
  }

  private async panel(connector: string, panel: DashboardPanel): Promise<PanelResult> {
    const base = { id: panel.id, title: panel.title, view: panel.view.kind };
    const hosted = this.deps.host.get(`${connector}__${panel.tool}`);
    // Not running (failed to start, or the server does not offer it), or not a read.
    if (!hosted || hosted.risk !== 'read') return { ...base, results: [], note: 'unavailable' };
    const calls = callsFor(hosted, panel);
    if (calls.length === 0) return { ...base, results: [], note: 'no-targets' };
    const results = await Promise.all(calls.map((c) => this.call(hosted, panel.view, c)));
    return { ...base, results };
  }

  private async call(
    hosted: HostedTool,
    view: DashboardView,
    { target, args }: { target: string | null; args: Record<string, unknown> },
  ): Promise<TargetResult> {
    const decision = decide(
      policyInputFor(hosted, args, this.deps.policy.destructiveActions, this.deps.policy.self),
    );
    if (decision.kind !== 'allow') {
      return {
        target,
        error: this.deps.redactor.redact(
          decision.kind === 'block' ? decision.reason : 'needs approval',
        ),
      };
    }
    try {
      const result = await this.deps.host.call(
        hosted.name,
        args,
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      const text = this.deps.redactor.redact(result.text);
      if (result.isError) return { target, error: clip(text) || 'the tool failed' };
      const data = parseView(view, text, hosted.settings);
      return data ? { target, data } : { target, error: 'could not read the output' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { target, error: clip(this.deps.redactor.redact(message)) };
    }
  }
}

/** One call per entry of the forEach setting, or a single call. */
function callsFor(
  hosted: HostedTool,
  panel: DashboardPanel,
): { target: string | null; args: Record<string, unknown> }[] {
  const fixed: Record<string, unknown> = { ...panel.args };
  const each = panel.forEach;
  if (!each) return [{ target: null, args: fixed }];
  const settings = each.from ? hosted.sharedSettings?.[each.from] : hosted.settings;
  const raw = settings?.[each.setting];
  const values = (Array.isArray(raw) ? raw : [])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, MAX_TARGETS);
  return values.flatMap((value) => {
    if (!each.repoArg) return [{ target: value, args: { ...fixed, [each.arg]: value } }];
    const [owner, repo, ...rest] = value.split('/');
    if (!owner || !repo || rest.length > 0) return [];
    return [{ target: value, args: { ...fixed, [each.arg]: owner, [each.repoArg]: repo } }];
  });
}

export function parseView(
  view: DashboardView,
  text: string,
  settings: Readonly<Record<string, unknown>> = {},
): PanelData | null {
  switch (view.kind) {
    case 'pods':
      return podsData(parseTable(text));
    case 'deployments':
      return deploymentsData(parseTable(text));
    case 'events':
      return eventsData(text);
    case 'runs':
      return runsData(view, text);
    case 'jobs':
      return jobsData(view, text, settings);
  }
}

const JOB_ORDER: Record<RunState, number> = { failed: 0, running: 1, passed: 2, other: 3 };

function jobsData(
  view: Extract<DashboardView, { kind: 'jobs' }>,
  text: string,
  settings: Readonly<Record<string, unknown>>,
): JobsData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = view.items ? pick(parsed, view.items) : parsed;
  if (!Array.isArray(list)) return null;
  // Only what the connector is scoped to, by the same rule as its guards.
  const scope = view.scope;
  const allowed = scope
    ? (Array.isArray(settings[scope.setting]) ? (settings[scope.setting] as unknown[]) : []).filter(
        (v): v is string => typeof v === 'string',
      )
    : null;
  const counts: Record<RunState, number> = { passed: 0, failed: 0, running: 0, other: 0 };
  const jobs = (list as unknown[])
    .filter((item) => {
      if (!scope || !allowed) return true;
      const value = str(pick(item, scope.field));
      return value !== '' && inList(value, allowed, true);
    })
    .map((item) => {
      const status = str(pick(item, view.fields.status));
      const state = view.states[status] ?? 'other';
      counts[state] += 1;
      const url = str(pick(item, view.fields.url));
      return {
        name: clip(str(pick(item, view.fields.name)), 200),
        state,
        status: clip(status, 40),
        url: /^https?:\/\//i.test(url) ? clip(url, 500) : null,
      };
    })
    .sort((a, b) => JOB_ORDER[a.state] - JOB_ORDER[b.state] || a.name.localeCompare(b.name));
  return { kind: 'jobs', counts, jobs: jobs.slice(0, MAX_ROWS * 3) };
}

/**
 * A kubectl-style table: a header row of upper-case names, columns aligned by spaces.
 * Cells are cut at the header's column starts, so values with single spaces stay whole.
 */
export function parseTable(text: string): Record<string, string>[] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const at = lines.findIndex((l) => /^\s*(NAMESPACE|NAME)\s{2,}/.test(l));
  if (at === -1) {
    // An empty namespace has no table: nothing, or only a sentence.
    return lines.some((l) => /\s{2,}\S/.test(l)) ? null : [];
  }
  const header = lines[at] ?? '';
  const columns = [...header.matchAll(/\S+/g)].map((m) => ({ name: m[0], start: m.index }));
  return lines.slice(at + 1).map((line) => {
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      const end = columns[i + 1]?.start ?? line.length;
      row[c.name] = line.slice(c.start, end).trim();
    });
    return row;
  });
}

const PENDING = /^(Pending|ContainerCreating|PodInitializing|Init:|Terminating)/;

function podsData(rows: Record<string, string>[] | null): PodsData | null {
  if (!rows) return null;
  const counts: Record<PodState, number> = { running: 0, pending: 0, failing: 0, completed: 0 };
  const pods = rows.map((r) => {
    const status = r['STATUS'] ?? '';
    const ready = r['READY'] ?? '';
    const [up, want] = ready.split('/').map(Number);
    const restarts = Number.parseInt(r['RESTARTS'] ?? '0', 10) || 0;
    let state: PodState;
    if (status === 'Completed' || status === 'Succeeded') state = 'completed';
    else if (status === 'Running') state = up === want ? 'running' : 'pending';
    else if (PENDING.test(status)) state = 'pending';
    else state = 'failing';
    counts[state] += 1;
    return {
      namespace: r['NAMESPACE'] ?? '',
      name: r['NAME'] ?? '',
      status,
      ready,
      restarts,
      state,
    };
  });
  const rank = (p: (typeof pods)[number]) => (p.state === 'failing' ? 1 : 0);
  const shown = pods
    .filter((p) => p.state === 'failing' || p.restarts > 0)
    .sort((a, b) => rank(b) - rank(a) || b.restarts - a.restarts)
    .slice(0, MAX_ROWS)
    .map((p) => ({
      namespace: p.namespace,
      name: p.name,
      status: clip(p.status, 60),
      ready: p.ready,
      restarts: p.restarts,
    }));
  return { kind: 'pods', counts, pods: shown };
}

function deploymentsData(rows: Record<string, string>[] | null): DeploymentsData | null {
  if (!rows) return null;
  const deployments = rows.map((r) => {
    const [ready = 0, desired = 0] = (r['READY'] ?? '').split('/').map((n) => Number(n) || 0);
    return { namespace: r['NAMESPACE'] ?? '', name: r['NAME'] ?? '', ready, desired };
  });
  const healthy = (d: { ready: number; desired: number }) => d.ready >= d.desired;
  return {
    kind: 'deployments',
    ready: deployments.filter(healthy).length,
    total: deployments.length,
    // Not ready first.
    deployments: deployments
      .sort((a, b) => Number(healthy(a)) - Number(healthy(b)) || a.name.localeCompare(b.name))
      .slice(0, MAX_ROWS * 2),
  };
}

function eventsData(text: string): EventsData | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  // No events: an empty answer, or only a comment.
  if (parsed === null || parsed === undefined) return { kind: 'events', warnings: [] };
  if (!Array.isArray(parsed)) return null;
  const byKey = new Map<string, EventsData['warnings'][number]>();
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (e['Type'] !== 'Warning') continue;
    const involved = (e['InvolvedObject'] ?? {}) as Record<string, unknown>;
    const object = `${str(involved['Kind'])}/${str(involved['Name'])}`;
    const reason = str(e['Reason']);
    const key = `${reason} ${object}`;
    const seen = byKey.get(key);
    byKey.delete(key);
    // Later events win: the server lists them oldest first.
    byKey.set(key, {
      reason: clip(reason, 80),
      object: clip(object, 120),
      message: clip(str(e['Message'])),
      at: clip(str(e['Timestamp']), 40),
      count: (seen?.count ?? 0) + 1,
    });
  }
  return { kind: 'events', warnings: [...byKey.values()].reverse().slice(0, MAX_ROWS) };
}

const PASSED = new Set(['success', 'passed']);
const FAILED = new Set(['failed', 'failure', 'timed_out', 'startup_failure']);
const RUNNING = new Set([
  'running',
  'in_progress',
  'pending',
  'queued',
  'waiting',
  'waiting_for_resource',
  'preparing',
  'created',
  'requested',
]);

export function runState(status: string): RunState {
  if (PASSED.has(status)) return 'passed';
  if (FAILED.has(status)) return 'failed';
  if (RUNNING.has(status)) return 'running';
  return 'other';
}

function runsData(view: Extract<DashboardView, { kind: 'runs' }>, text: string): RunsData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = view.items ? pick(parsed, view.items) : parsed;
  if (!Array.isArray(list)) return null;
  const counts: Record<RunState, number> = { passed: 0, failed: 0, running: 0, other: 0 };
  const runs = (list as unknown[]).map((item) => {
    const status =
      view.fields.status.map((p) => str(pick(item, p))).find((s) => s !== '') ?? 'unknown';
    const state = runState(status);
    counts[state] += 1;
    const url = str(pick(item, view.fields.url));
    const name = view.fields.name ? str(pick(item, view.fields.name)) : '';
    return {
      id: clip(str(pick(item, view.fields.id)), 40),
      name: name ? clip(name, 120) : null,
      ref: clip(str(pick(item, view.fields.ref)), 120),
      state,
      status: clip(status, 40),
      // Only web links, never javascript: or data: URLs from tool output.
      url: /^https?:\/\//i.test(url) ? clip(url, 500) : null,
      at: clip(str(pick(item, view.fields.at)), 40),
    };
  });
  return { kind: 'runs', counts, runs: runs.slice(0, MAX_ROWS) };
}

function pick(value: unknown, path: string): unknown {
  let at = value;
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function clip(text: string, max = MAX_TEXT): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
