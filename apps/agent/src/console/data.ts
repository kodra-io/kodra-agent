import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getModelProvider } from '@kodra-agent/connectors';
import type { ModelPrice } from '@kodra-agent/schema';
import { alwaysBlocked } from '../agent.ts';
import type { AuditRecord } from '../audit.ts';
import { describeGuards } from '../policy.ts';
import type { Redactor } from '../redactor.ts';
import { failureHint, type Runtime } from '../runtime.ts';

/**
 * Read-only views for the console, built from the running agent and its local records. Every
 * record was redacted when it was written; text from tools and alerts is shown as data only.
 */

export interface ConnectorView {
  id: string;
  name: string;
  /** The manifest category (source, deploy, build, chat, ...), for connectors without tools. */
  category: string;
  access: string | null;
  available: boolean;
  reason?: string;
  hint?: string;
  /** Tools the model is offered, with the limits it is told. */
  tools: { name: string; risk: string; limits: string[] }[];
}

export interface StatusView {
  version: string;
  model: string;
  target: string;
  startedAt: string;
  uptimeSeconds: number;
  slack: boolean;
  monitoring: boolean;
  connectors: { id: string; name: string; available: boolean }[];
}

export interface Investigation {
  ts: string;
  alert: string;
  severity: string;
  summary: string;
  findings: string;
  stoppedBy?: string;
}

export interface ActivityQuery {
  event?: string | undefined;
  decision?: string | undefined;
  connector?: string | undefined;
  actor?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  /** Only records older than this timestamp (for paging). */
  before?: string | undefined;
}

export interface UsageTotals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Estimated US dollars, or null when no price is known. */
  cost: number | null;
}

export interface UsageView {
  model: string;
  pricing: { source: string; asOf: string | null; overridden: boolean } | null;
  totals: UsageTotals;
  days: (UsageTotals & { day: string })[];
  questions: (UsageTotals & { task: string; ts: string; actor: string })[];
}

export interface ApprovalView {
  /** A proposed change's title. */
  title?: string;
  id: string;
  ts: string;
  connector: string;
  tool: string;
  risk: string;
  requestedBy: string;
  args: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** Investigation findings, one JSON line each, next to the audit log (owner-only, redacted). */
export class InvestigationLog {
  readonly path: string;
  private readonly redactor: Redactor;

  constructor(auditPath: string, redactor: Redactor) {
    this.path = join(dirname(auditPath), 'investigations.jsonl');
    this.redactor = redactor;
  }

  async append(item: Investigation): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${this.redactor.redact(JSON.stringify(item))}\n`, {
      mode: 0o600,
    });
  }

  /** Newest first. */
  async list(limit = 50): Promise<Investigation[]> {
    const lines = await readLines(this.path);
    return lines
      .map((l) => parseJson(l) as Investigation | null)
      .filter((x): x is Investigation => x !== null)
      .reverse()
      .slice(0, limit);
  }
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.trim() !== '');
}

/** Lines written by this agent; a damaged line is skipped, not fatal. */
function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

/** Audit records, oldest first: the rotated file (.1) then the current one. */
export async function readAudit(path: string): Promise<AuditRecord[]> {
  const lines = [...(await readLines(`${path}.1`)), ...(await readLines(path))];
  return lines
    .map((l) => parseJson(l) as AuditRecord | null)
    .filter((r): r is AuditRecord => r !== null);
}

export function status(
  runtime: Runtime,
  info: { version: string; startedAt: Date; slack: boolean; monitoring: boolean; now?: Date },
): StatusView {
  const connectors = connectorViews(runtime);
  return {
    version: info.version,
    model: `${runtime.config.spec.model.provider}/${runtime.config.spec.model.name}`,
    target: runtime.config.spec.target,
    startedAt: info.startedAt.toISOString(),
    uptimeSeconds: Math.round(
      ((info.now ?? new Date()).getTime() - info.startedAt.getTime()) / 1000,
    ),
    slack: info.slack,
    monitoring: info.monitoring,
    connectors: connectors.map(({ id, name, available }) => ({ id, name, available })),
  };
}

export function connectorViews(runtime: Runtime): ConnectorView[] {
  const policy = {
    destructiveActions: runtime.config.spec.policy.destructiveActions,
    expiresAfterMinutes: runtime.config.spec.policy.approvals.expiresAfterMinutes,
  };
  const offered = runtime.host.tools().filter((t) => !alwaysBlocked(t, policy, false));
  const failures = runtime.host.failures();
  const views: ConnectorView[] = runtime.inputs.map((input) => {
    const id = input.component.id;
    const tools = offered
      .filter((t) => t.connector === id)
      .map((t) => ({
        name: t.tool,
        risk: t.risk,
        limits: describeGuards(t.guards, t.settings, t.sharedSettings),
      }));
    const failure = failures.find((f) => f.connector === id);
    const down = failure !== undefined && tools.length === 0;
    return {
      id,
      name: input.component.displayName,
      category: input.component.manifest.category,
      access: input.access ?? null,
      available: !down,
      ...(down
        ? {
            reason: failure.reason,
            hint: failureHint(failure, runtime.config, runtime.inputs, runtime.env),
          }
        : {}),
      tools,
    };
  });
  // Connectors left out before starting (a missing secret) are not inputs.
  for (const failure of failures) {
    if (views.some((v) => v.id === failure.connector)) continue;
    views.push({
      id: failure.connector,
      name: failure.displayName,
      category: '',
      access: null,
      available: false,
      reason: failure.reason,
      hint: failureHint(failure, runtime.config, runtime.inputs, runtime.env),
      tools: [],
    });
  }
  return views;
}

/** Newest first, filtered. Text search covers the tool, actor, task, and detail. */
export function activity(records: readonly AuditRecord[], query: ActivityQuery): AuditRecord[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const q = query.q?.toLowerCase();
  const out: AuditRecord[] = [];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const r = records[i];
    if (!r) continue;
    if (query.before && r.ts >= query.before) continue;
    if (query.event && r.event !== query.event) continue;
    if (query.decision && r.decision !== query.decision) continue;
    if (query.connector && r.connector !== query.connector) continue;
    if (query.actor && r.actor !== query.actor) continue;
    if (q && ![r.tool, r.actor, r.task, r.detail].some((f) => f?.toLowerCase().includes(q))) {
      continue;
    }
    out.push(r);
  }
  return out;
}

/** The price for a model label (provider/name): the config's override, else the list price. */
export function priceFor(
  modelLabel: string,
  override: ModelPrice | undefined,
): { price: ModelPrice; source: string; asOf: string | null; overridden: boolean } | null {
  if (override)
    return { price: override, source: 'kodra-agent.yaml', asOf: null, overridden: true };
  const slash = modelLabel.indexOf('/');
  const provider = getModelProvider(modelLabel.slice(0, slash));
  const pricing = provider?.pricing;
  const price = pricing?.models[modelLabel.slice(slash + 1)];
  return pricing && price
    ? { price, source: pricing.source, asOf: pricing.asOf, overridden: false }
    : null;
}

export function costOf(t: Omit<UsageTotals, 'cost'>, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const uncached = Math.max(0, t.input - t.cacheRead - t.cacheWrite);
  const dollars =
    (uncached * price.inputPerMTok +
      t.cacheRead * (price.cacheReadPerMTok ?? price.inputPerMTok) +
      t.cacheWrite * (price.cacheWritePerMTok ?? price.inputPerMTok) +
      t.output * price.outputPerMTok) /
    1_000_000;
  return Math.round(dollars * 10_000) / 10_000;
}

function emptyTotals(): Omit<UsageTotals, 'cost'> {
  return { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Token use from model.call records, per day and per question, with an estimated cost. */
export function usage(
  records: readonly AuditRecord[],
  modelLabel: string,
  override: ModelPrice | undefined,
): UsageView {
  const priced = priceFor(modelLabel, override);
  const total = emptyTotals();
  const days = new Map<string, Omit<UsageTotals, 'cost'>>();
  const questions = new Map<string, Omit<UsageTotals, 'cost'> & { ts: string; actor: string }>();
  for (const r of records) {
    if (r.event !== 'model.call' || !r.usage) continue;
    const add = (t: Omit<UsageTotals, 'cost'>) => {
      t.calls += 1;
      t.input += r.usage?.input ?? 0;
      t.cacheRead += r.usage?.cacheRead ?? 0;
      t.cacheWrite += r.usage?.cacheWrite ?? 0;
      t.output += r.usage?.output ?? 0;
    };
    add(total);
    const day = r.ts.slice(0, 10);
    const d = days.get(day) ?? emptyTotals();
    add(d);
    days.set(day, d);
    if (r.task) {
      const q = questions.get(r.task) ?? { ...emptyTotals(), ts: r.ts, actor: r.actor };
      add(q);
      questions.set(r.task, q);
    }
  }
  const price = priced?.price;
  return {
    model: modelLabel,
    pricing: priced
      ? { source: priced.source, asOf: priced.asOf, overridden: priced.overridden }
      : null,
    totals: { ...total, cost: costOf(total, price) },
    days: [...days]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, t]) => ({ day, ...t, cost: costOf(t, price) })),
    questions: [...questions]
      .map(([task, t]) => ({ task, ...t, cost: costOf(t, price) }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, 50),
  };
}

/** Approval requests and their decisions, newest first. Undecided ones have decision null. */
export function approvals(records: readonly AuditRecord[]): ApprovalView[] {
  const byId = new Map<string, ApprovalView>();
  for (const r of records) {
    const id = r.detail?.split(';')[0]?.trim();
    if (!id) continue;
    if (r.event === 'approval.request') {
      const title = /; change: (.*?); steps: /.exec(r.detail ?? '')?.[1];
      byId.set(id, {
        id,
        ts: r.ts,
        connector: r.connector ?? '',
        tool: r.tool ?? '',
        risk: r.risk ?? '',
        requestedBy: r.actor,
        args: r.detail?.replace(/^[^;]*;\s*args\s*/, '') ?? '',
        ...(title ? { title } : {}),
        decision: null,
        decidedBy: null,
        decidedAt: null,
      });
    } else if (r.event === 'approval.decision') {
      const req = byId.get(id);
      // A refused click by someone who is not an approver is not the decision.
      if (!req || req.decision !== null || r.decision === 'blocked') continue;
      req.decision = r.decision ?? null;
      req.decidedBy = r.actor;
      req.decidedAt = r.ts;
    }
  }
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/** The Overview page's numbers, from the audit log and the investigation log. */
export interface OverviewView {
  investigationsToday: number;
  lastInvestigation: { alert: string; ts: string } | null;
  changesThisWeek: { approved: number; denied: number; expired: number };
  recentChanges: ApprovalView[];
}

export function overview(
  records: readonly AuditRecord[],
  investigations: readonly Investigation[],
  now: Date = new Date(),
): OverviewView {
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const decided = approvals(records).filter((a) => a.decision !== null);
  const thisWeek = decided.filter((a) => (a.decidedAt ?? a.ts) >= weekAgo);
  const count = (d: string) => thisWeek.filter((a) => a.decision === d).length;
  const latest = investigations[0];
  return {
    investigationsToday: investigations.filter((i) => i.ts.startsWith(today)).length,
    lastInvestigation: latest ? { alert: latest.alert, ts: latest.ts } : null,
    changesThisWeek: {
      approved: count('approved'),
      denied: count('denied'),
      expired: count('expired'),
    },
    recentChanges: decided.slice(0, 5),
  };
}
