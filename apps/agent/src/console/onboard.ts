import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApprovalChannel } from '../approvals.ts';
import { ship, type ShipHooks, type ShipResult } from '../commands/ship.ts';
import type { Context } from '../context.ts';
import { writePrivateFile } from '../env-file.ts';
import type { Runtime } from '../runtime.ts';
import {
  MAX_KEEP_MS,
  sandboxDeploy,
  sandboxDestroy,
  sandboxList,
  sandboxSetup,
} from '../sandbox/sandbox.ts';
import type { SandboxTest } from '../sandbox/state.ts';

/**
 * Onboarding from the console (M30a): analyze a configured repo (the report, posted to
 * Slack), then open the PR with the files it needs, after the same one approval as the CLI.
 * Runs in the running agent, one job at a time, in the background; the agent has no Docker
 * socket, so the PR's CI builds the image. Jobs are kept next to the audit log (reports and
 * progress only: redacted, never a secret), so they can be opened again after a restart.
 */

/** `sandbox` deploys a branch to the sandbox, tests it, and destroys it (B2). */
export type JobKind = 'analyze' | 'pr' | 'sandbox';
export type JobState = 'running' | 'done' | 'failed';

export interface OnboardJob {
  id: string;
  kind: JobKind;
  repo: string;
  branch: string | null;
  by: string;
  startedAt: string;
  endedAt: string | null;
  state: JobState;
  /** What the job printed, redacted. */
  log: string[];
  report: string | null;
  shippable: boolean | null;
  risks: number | null;
  gaps: number | null;
  prUrl: string | null;
  /** A sandbox test: whether it passed, and until when it is kept (null: destroyed). */
  test?: { id: string; passed: boolean; keptUntil: string | null };
}

/** A configured GitHub repo or GitLab project the console can onboard. */
export interface OnboardRepo {
  provider: 'github' | 'gitlab';
  repo: string;
  /** Whether its connector can push a branch and open a PR. */
  canOpenPr: boolean;
}

const MAX_JOBS = 50;
const MAX_LOG = 400;

export interface OnboardDeps {
  runtime: Runtime;
  ctx: Context;
  configPath: string;
  /** The console and Slack approvals, as for chat. */
  approvals: ApprovalChannel;
  /** The team's Slack channel, when Slack is on. */
  post?: (text: string) => Promise<void>;
  path: string;
  now?: () => Date;
}

export class OnboardJobs {
  private readonly deps: OnboardDeps;
  private jobs: OnboardJob[] = [];
  private running: Promise<void> | null = null;

  constructor(deps: OnboardDeps) {
    this.deps = deps;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.deps.path, 'utf8')) as { jobs?: OnboardJob[] };
      // A job that was running when the agent stopped did not finish.
      this.jobs = (saved.jobs ?? []).map((j) =>
        j.state === 'running'
          ? { ...j, state: 'failed', log: [...j.log, 'Stopped: the agent restarted.'] }
          : j,
      );
    } catch {
      this.jobs = [];
    }
  }

  repos(): OnboardRepo[] {
    return this.deps.runtime.inputs.flatMap((input) => {
      const id = input.component.id;
      if (id !== 'github' && id !== 'gitlab') return [];
      const key = id === 'github' ? 'repos' : 'projects';
      const list = input.component.settings[key];
      const canOpenPr = input.access === 'read-write-approved';
      return (Array.isArray(list) ? list.map(String) : []).map((repo) => ({
        provider: id,
        repo,
        canOpenPr,
      }));
    });
  }

  list(): (Omit<OnboardJob, 'log' | 'report'> & { log: undefined; report: undefined })[] {
    // Reports and logs are read one job at a time.
    return this.jobs.map((j) => ({ ...j, log: undefined, report: undefined }));
  }

  /** The sandbox (B2): its namespace, or why there is none, and the tests that are up. */
  async sandbox(): Promise<{
    namespace: string | null;
    reason: string | null;
    tests: SandboxTest[];
  }> {
    const setup = sandboxSetup(this.deps.runtime);
    return {
      namespace: setup.ok ? setup.setup.namespace : null,
      reason: setup.ok ? null : setup.reason,
      tests: await sandboxList(this.deps.runtime),
    };
  }

  /** Destroys one of the agent's own sandbox tests now. */
  destroy(id: string, by: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return sandboxDestroy(this.deps.ctx, this.deps.runtime, id, by);
  }

  get(id: string): OnboardJob | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  /** Waits for the job that is running, if any (tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Starts a job, or says why it cannot start. */
  start(
    kind: JobKind,
    repoInput: string,
    branch: string | null,
    by: string,
    keepMs = 0,
  ): { job: OnboardJob } | { error: string; status: number } {
    if (this.running)
      return { status: 409, error: 'another onboarding or sandbox test is running; wait for it' };
    const repo = this.repos().find((r) => r.repo.toLowerCase() === repoInput.toLowerCase());
    if (!repo) {
      return {
        status: 400,
        error:
          'that is not one of the configured GitHub repos or GitLab projects; add it in Settings, Connectors first',
      };
    }
    if (kind === 'pr' && !repo.canOpenPr) {
      return {
        status: 400,
        error: `the ${repo.provider === 'github' ? 'GitHub' : 'GitLab'} connector is read-only; give it read-write-approved access in Settings, Connectors to open a pull request`,
      };
    }
    if (kind === 'sandbox') {
      const setup = sandboxSetup(this.deps.runtime);
      if (!setup.ok) return { status: 400, error: setup.reason };
      if (!Number.isInteger(keepMs) || keepMs < 0 || keepMs > MAX_KEEP_MS) {
        return { status: 400, error: 'a test can be kept for at most 24 hours' };
      }
    }
    if (branch !== null && !/^[\w./-]{1,200}$/.test(branch)) {
      return { status: 400, error: 'that is not a branch name' };
    }
    const now = (this.deps.now ?? (() => new Date()))();
    const job: OnboardJob = {
      id: `onb-${randomUUID().slice(0, 8)}`,
      kind,
      repo: repo.repo,
      branch,
      by,
      startedAt: now.toISOString(),
      endedAt: null,
      state: 'running',
      log: [],
      report: null,
      shippable: null,
      risks: null,
      gaps: null,
      prUrl: null,
    };
    this.jobs = [job, ...this.jobs].slice(0, MAX_JOBS);
    this.running = (kind === 'sandbox' ? this.test(job, keepMs) : this.run(job)).finally(() => {
      this.running = null;
    });
    void this.save();
    return { job };
  }

  /** The job's own log, redacted. */
  private logger(job: OnboardJob): (text: string) => void {
    const redactor = this.deps.ctx.redactor;
    return (text: string) => {
      for (const l of redactor.redact(text).split('\n')) {
        job.log.push(l);
        if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
      }
    };
  }

  private async finish(job: OnboardJob, code: number): Promise<void> {
    job.state = code === 0 ? 'done' : 'failed';
    job.endedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    await this.save();
  }

  private async test(job: OnboardJob, keepMs: number): Promise<void> {
    const ctx = this.deps.ctx;
    const line = this.logger(job);
    let code = 1;
    try {
      code = await sandboxDeploy(
        {
          configPath: this.deps.configPath,
          repo: job.repo,
          branch: job.branch ?? undefined,
          keepMs,
        },
        { ...ctx, term: { out: line, err: line }, prompter: null },
        {
          runtime: this.deps.runtime,
          approvals: this.deps.approvals,
          requestedBy: job.by,
          ...(this.deps.post ? { post: this.deps.post } : {}),
          onResult: (r) => {
            job.report = ctx.redactor.redact(r.report);
            job.test = { id: r.id, passed: r.passed, keptUntil: r.keptUntil ?? null };
            void this.save();
          },
        },
      );
    } catch (error) {
      line(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.finish(job, code);
  }

  private async run(job: OnboardJob): Promise<void> {
    const ctx = this.deps.ctx;
    const redactor = ctx.redactor;
    const line = this.logger(job);
    const hooks: ShipHooks = {
      runtime: this.deps.runtime,
      approvals: this.deps.approvals,
      verify: 'ci',
      reportOnly: job.kind === 'analyze',
      requestedBy: job.by,
      ...(this.deps.post ? { post: this.deps.post } : {}),
      onResult: (r: ShipResult) => {
        if (r.report !== undefined) job.report = redactor.redact(r.report);
        if (r.shippable !== undefined) job.shippable = r.shippable;
        if (r.risks !== undefined) job.risks = r.risks;
        if (r.gaps !== undefined) job.gaps = r.gaps;
        if (r.prUrl !== undefined) job.prUrl = r.prUrl;
        void this.save();
      },
    };
    let code = 1;
    try {
      code = await ship(
        {
          configPath: this.deps.configPath,
          target: job.repo,
          branch: job.branch ?? undefined,
          maxFixes: 0,
          onboard: true,
        },
        // No terminal here: the job's own log, and approvals through the console and Slack.
        { ...ctx, term: { out: line, err: line }, prompter: null },
        hooks,
      );
    } catch (error) {
      line(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.finish(job, code);
  }

  private async save(): Promise<void> {
    await writePrivateFile(this.deps.path, JSON.stringify({ jobs: this.jobs }, null, 2)).catch(
      () => undefined,
    );
  }
}
