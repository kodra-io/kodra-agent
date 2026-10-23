import { randomUUID } from 'node:crypto';
import { scheduleDue, type ScheduleInput } from '@kodra-agent/schema';
import type { AuditLog, ChainCheck } from '../audit.ts';
import type { BudgetState } from '../budget.ts';
import type { DashboardResult } from '../dashboard.ts';
import type { Alert } from '../monitoring/alerts.ts';
import type { Redactor } from '../redactor.ts';
import { digestText, isClean } from './digest.ts';
import {
  agentFindings,
  alertFindings,
  CHECK_TITLES,
  dashboardFindings,
  type CheckGap,
  type CheckId,
  type Finding,
  type RuleOptions,
} from './rules.ts';
import type { ChecksState, Digest } from './state.ts';

export interface CheckRunnerDeps {
  /** The console dashboard's reads (read tools only, through the policy and the redactor). */
  dashboard: () => Promise<DashboardResult>;
  /** Firing alerts; undefined when no alert source is configured. */
  alerts?: (() => Promise<Alert[]>) | undefined;
  self: () => Promise<{ chain: ChainCheck; budget: BudgetState | null; pendingApprovals: number }>;
  rules?: RuleOptions;
  state: ChecksState;
  audit: AuditLog;
  redactor: Redactor;
  /** Where a digest goes (the Slack channel, else the terminal). */
  post: (text: string) => Promise<void>;
  schedules: readonly ScheduleInput[];
  quietWhenClean: boolean;
  now?: () => Date;
}

const TICK_MS = 60_000;

/**
 * Runs the checks on their schedules and on demand, and posts the digest. A run never calls
 * the model or a write tool, so it needs no approval and costs nothing. One run at a time:
 * a request during a run gets that run's digest.
 */
export class CheckRunner {
  private readonly deps: CheckRunnerDeps;
  private readonly now: () => Date;
  private running: Promise<Digest> | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: CheckRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get latest(): Digest | null {
    return this.deps.state.latest;
  }

  get schedules(): readonly ScheduleInput[] {
    return this.deps.schedules;
  }

  /** Checks the schedules every minute until stop(). */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async idle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Runs each schedule that is due, at most once per local day. */
  async tick(): Promise<void> {
    for (const schedule of this.deps.schedules) {
      const { due, date } = scheduleDue(
        schedule,
        this.deps.state.lastRun(schedule.name),
        this.now(),
      );
      if (!due) continue;
      this.deps.state.markRun(schedule.name, date);
      // An on-demand run in progress is not this schedule's digest: wait for it, then run.
      await this.idle();
      await this.run(schedule.name, { post: true, commit: true }).catch(() => undefined);
    }
  }

  /**
   * One run. `commit` saves the result as the latest digest and the open findings; `post`
   * sends it (unless it is clean and quietWhenClean is on).
   */
  run(trigger: string, opts: { post: boolean; commit: boolean }): Promise<Digest> {
    this.running ??= this.runOnce(trigger, opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(
    trigger: string,
    opts: { post: boolean; commit: boolean },
  ): Promise<Digest> {
    const task = `checks-${randomUUID().slice(0, 8)}`;
    const { audit } = this.deps;
    await audit.append({ event: 'task.start', actor: 'checks', task, detail: trigger });
    try {
      const findings: Finding[] = [];
      const gaps: CheckGap[] = [];
      const ran = new Set<CheckId>(['agent']);
      const observed = dashboardFindings(await this.deps.dashboard(), this.deps.rules);
      findings.push(...observed.findings);
      gaps.push(...observed.gaps);
      for (const c of observed.ran) ran.add(c);
      if (this.deps.alerts) {
        try {
          findings.push(...alertFindings(await this.deps.alerts()));
          ran.add('alerts');
        } catch (error) {
          gaps.push({
            check: 'alerts',
            where: 'alerts',
            reason: this.deps.redactor.redact(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
      const self = await this.deps.self();
      findings.push(...agentFindings(self));
      const checked = (Object.keys(CHECK_TITLES) as CheckId[]).filter((c) => ran.has(c));
      const skipped = (Object.keys(CHECK_TITLES) as CheckId[]).filter(
        (c) => !ran.has(c) && !gaps.some((g) => g.check === c),
      );
      const digest = this.deps.state.diff(
        findings,
        {
          at: this.now().toISOString(),
          trigger,
          gaps,
          ran: checked,
          skipped,
          auditHead: self.chain.head,
        },
        opts.commit,
      );
      if (opts.commit) await this.deps.state.save();
      const quiet = this.deps.quietWhenClean && isClean(digest);
      const posted = opts.post && !quiet;
      if (posted) await this.deps.post(this.deps.redactor.redact(digestText(digest)));
      await audit.append({
        event: 'result',
        actor: 'checks',
        task,
        detail: `${String(digest.fresh.length)} new, ${String(digest.ongoing.length)} ongoing, ${String(digest.resolved.length)} resolved, ${String(digest.gaps.length)} not checked; ${posted ? 'posted' : quiet ? 'clean, not posted' : 'not posted'}`,
      });
      return digest;
    } catch (error) {
      await audit.append({
        event: 'error',
        actor: 'checks',
        task,
        detail: this.deps.redactor.redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }
}
