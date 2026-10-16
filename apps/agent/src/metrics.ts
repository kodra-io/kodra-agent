import { connectors } from '@kodra-agent/connectors';

/**
 * The agent's own metrics (PLAN-v0.2 M14), in the Prometheus text format, built from the audit
 * records as they are written: every tool call, approval, model call, investigation, and error
 * is already recorded there, so nothing else needs hooks. Label values come only from fixed
 * sets (connector ids, risks, decisions, configured model labels); anything else becomes
 * "other", so no user content can reach a label.
 */

const RISKS = new Set(['read', 'write', 'destructive', 'unclassified']);
const DECISIONS = new Set(['allowed', 'approved', 'denied', 'blocked', 'expired']);
const KINDS = ['input', 'cache_read', 'cache_write', 'output'] as const;

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Family {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly type: 'counter' | 'gauge';
  readonly help: string;

  constructor(name: string, type: 'counter' | 'gauge', help: string) {
    this.name = name;
    this.type = type;
    this.help = help;
  }

  add(labels: Labels, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const [labels, value] of this.values) {
      out.push(`${this.name}${labels ? `{${labels}}` : ''} ${String(value)}`);
    }
    return out;
  }
}

export interface MetricsOptions {
  version: string;
  /** Model labels this config can use (provider/name): anything else is "other". */
  models: readonly string[];
  /** Estimated cost of a model call, in US dollars. */
  cost?: (model: string, usage: Record<string, number>) => number;
}

export class AgentMetrics {
  private readonly connectorIds = new Set(connectors.map((c) => c.id));
  private readonly models: Set<string>;
  private readonly cost: MetricsOptions['cost'];
  private readonly pending = new Map<string, number>();
  private readonly started = new Map<string, number>();
  private budget: { remaining: number; ratio: number } | null = null;

  private readonly info = new Family('kodra_agent_info', 'gauge', 'The running agent.');
  private readonly toolCalls = new Family(
    'kodra_agent_tool_calls_total',
    'counter',
    'Tool calls by connector, risk, and policy decision.',
  );
  private readonly approvalsPending = new Family(
    'kodra_agent_approvals_pending',
    'gauge',
    'Approval requests waiting for a decision.',
  );
  private readonly approvalOldest = new Family(
    'kodra_agent_approval_oldest_seconds',
    'gauge',
    'How long the oldest waiting approval request has waited.',
  );
  private readonly approvalWait = new Family(
    'kodra_agent_approval_wait_seconds_sum',
    'counter',
    'Total time decided requests waited, by decision.',
  );
  private readonly approvalCount = new Family(
    'kodra_agent_approval_wait_seconds_count',
    'counter',
    'Decided requests, by decision.',
  );
  private readonly investigations = new Family(
    'kodra_agent_investigations_total',
    'counter',
    'Alert investigations finished.',
  );
  private readonly investigationSeconds = new Family(
    'kodra_agent_investigation_seconds_sum',
    'counter',
    'Total time spent on alert investigations.',
  );
  private readonly tokens = new Family(
    'kodra_agent_model_tokens_total',
    'counter',
    'Model tokens by model and kind.',
  );
  private readonly costUsd = new Family(
    'kodra_agent_model_cost_usd_total',
    'counter',
    'Estimated model cost in US dollars, by model.',
  );
  private readonly connectorUp = new Family(
    'kodra_agent_connector_up',
    'gauge',
    'Whether each enabled connector started (1) or not (0).',
  );
  private readonly errors = new Family(
    'kodra_agent_errors_total',
    'counter',
    'Errors recorded in the audit log.',
  );
  private readonly budgetRemaining = new Family(
    'kodra_agent_budget_remaining_usd',
    'gauge',
    "What is left of this month's model budget, in US dollars.",
  );
  private readonly budgetRatio = new Family(
    'kodra_agent_budget_remaining_ratio',
    'gauge',
    "The share of this month's model budget that is left, from 0 to 1.",
  );

  constructor(opts: MetricsOptions) {
    this.models = new Set(opts.models);
    this.cost = opts.cost;
    this.info.set({ version: /^[\w.+-]{1,40}$/.test(opts.version) ? opts.version : 'other' }, 1);
    for (const kind of KINDS) for (const model of this.models) this.tokens.add({ model, kind }, 0);
  }

  private connector(value: unknown): string {
    // A proposed change lists several ("github, gitlab"): the first one names it.
    const first = typeof value === 'string' ? (value.split(',')[0]?.trim() ?? '') : '';
    return this.connectorIds.has(first) || first === 'kodra-agent' ? first : 'other';
  }

  private model(value: unknown): string {
    return typeof value === 'string' && this.models.has(value) ? value : 'other';
  }

  setConnectorUp(id: string, up: boolean): void {
    this.connectorUp.set({ connector: this.connector(id) }, up ? 1 : 0);
  }

  setBudget(state: { remaining: number; limit: number } | null): void {
    this.budget = state
      ? { remaining: state.remaining, ratio: state.limit > 0 ? state.remaining / state.limit : 0 }
      : null;
  }

  /** Feeds one audit record (the parsed, redacted line). */
  observe(record: Record<string, unknown>): void {
    const ts = Date.parse(String(record['ts']));
    const id = typeof record['detail'] === 'string' ? (record['detail'].split(';')[0] ?? '') : '';
    const task = typeof record['task'] === 'string' ? record['task'] : '';
    switch (record['event']) {
      case 'tool.call': {
        const risk = String(record['risk']);
        const decision = String(record['decision']);
        this.toolCalls.add({
          connector: this.connector(record['connector']),
          risk: RISKS.has(risk) ? risk : 'other',
          decision: DECISIONS.has(decision) ? decision : 'other',
        });
        break;
      }
      case 'approval.request':
        if (id) this.pending.set(id, ts);
        break;
      case 'approval.decision': {
        const decision = String(record['decision']);
        const since = this.pending.get(id);
        if (decision === 'blocked' || since === undefined) break;
        this.pending.delete(id);
        const label = { decision: DECISIONS.has(decision) ? decision : 'other' };
        this.approvalWait.add(label, Math.max(0, (ts - since) / 1000));
        this.approvalCount.add(label);
        break;
      }
      case 'model.call': {
        const model = this.model(record['model']);
        const usage = (record['usage'] ?? {}) as Record<string, number>;
        const counts: Record<(typeof KINDS)[number], number> = {
          input: usage['input'] ?? 0,
          cache_read: usage['cacheRead'] ?? 0,
          cache_write: usage['cacheWrite'] ?? 0,
          output: usage['output'] ?? 0,
        };
        for (const kind of KINDS) this.tokens.add({ model, kind }, counts[kind]);
        const cost = this.cost?.(String(record['model']), usage) ?? 0;
        if (cost > 0) this.costUsd.add({ model }, cost);
        break;
      }
      case 'task.start':
        if (task.startsWith('alert-')) this.started.set(task, ts);
        break;
      case 'result':
        if (task.startsWith('alert-')) {
          const since = this.started.get(task);
          this.started.delete(task);
          this.investigations.add({});
          if (since !== undefined)
            this.investigationSeconds.add({}, Math.max(0, (ts - since) / 1000));
        }
        break;
      case 'error':
        this.errors.add({ source: task.startsWith('alert-') ? 'investigation' : 'agent' });
        break;
    }
  }

  /** The text format, with the gauges that depend on the time of the scrape. */
  render(now: number = Date.now()): string {
    this.approvalsPending.set({}, this.pending.size);
    const oldest = Math.min(...this.pending.values());
    this.approvalOldest.set({}, this.pending.size > 0 ? Math.max(0, (now - oldest) / 1000) : 0);
    if (this.budget) {
      this.budgetRemaining.set({}, this.budget.remaining);
      this.budgetRatio.set({}, this.budget.ratio);
    }
    return `${[
      this.info,
      this.toolCalls,
      this.approvalsPending,
      this.approvalOldest,
      this.approvalWait,
      this.approvalCount,
      this.investigations,
      this.investigationSeconds,
      this.tokens,
      this.costUsd,
      this.connectorUp,
      this.errors,
      ...(this.budget ? [this.budgetRemaining, this.budgetRatio] : []),
    ]
      .flatMap((f) => f.render())
      .join('\n')}\n`;
  }
}
