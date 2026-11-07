import { resolvePolicy } from '@kodra-agent/schema';
import { policyInputFor } from '../agent.ts';
import { rulesFor, type ApprovalChannel } from '../approvals.ts';
import type { Context } from '../context.ts';
import type { HostedTool } from '../mcp/host.ts';
import { decide } from '../policy.ts';
import type { Runtime } from '../runtime.ts';
import { approveShipChange } from './approve.ts';

export interface JenkinsBuildInput {
  ctx: Context;
  runtime: Runtime;
  source: { provider: 'github' | 'gitlab'; repo: string; gitlabUrl?: string };
  /** The pull request's branch. */
  head: string;
  task: string;
  hooks: { approvals?: ApprovalChannel; requestedBy?: string };
}

/** How long to wait for Jenkins to find the branch, for the build, and between looks. */
export interface JenkinsTimings {
  discoverMs: number;
  buildMs: number;
  pollMs: number;
}

const TIMINGS: JenkinsTimings = { discoverMs: 5 * 60_000, buildMs: 30 * 60_000, pollMs: 10_000 };

interface LastBuild {
  number: number;
  result: string | null;
  building: boolean;
  url: string;
}

/** The plugin wraps every answer as `{message, result}`; no `result` means nothing found. */
function resultOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { result?: unknown }).result;
  } catch {
    return undefined;
  }
}

/**
 * After ship opens a pull request that Jenkins builds (B5): finds the Jenkins job for its
 * branch, waits for Jenkins to build it (a multibranch job finds new branches by webhook or
 * scan), or starts the build after one approval, then watches it and reports the result.
 * Uses the official plugin's tools, guarded by the connector's `jobs` like any other call.
 * Never fails ship: the pull request is open either way.
 */
export async function buildOnJenkins(i: JenkinsBuildInput): Promise<void> {
  const { ctx, runtime, source, head } = i;
  const t: JenkinsTimings = { ...TIMINGS, ...ctx.shipJenkins };
  const tools = new Map(
    runtime.host
      .tools()
      .filter((x) => x.connector === 'jenkins')
      .map((x) => [x.tool, x]),
  );
  const finder = tools.get('findJobsWithScmUrl');
  const getJob = tools.get('getJob');
  if (!finder || !getJob) {
    ctx.term.out(
      'Jenkins builds this pull request once a job picks up its branch. Ask the agent to start or check the build.',
    );
    return;
  }
  const destructive = runtime.config.spec.policy.destructiveActions;
  const allowed = (tool: HostedTool, args: Record<string, unknown>) =>
    decide(policyInputFor(tool, args, destructive)).kind !== 'block';
  const call = async (tool: HostedTool, args: Record<string, unknown>): Promise<unknown> => {
    if (!allowed(tool, args)) return undefined;
    try {
      const r = await runtime.host.call(tool.name, args);
      return r.isError ? undefined : resultOf(r.text);
    } catch {
      return undefined;
    }
  };
  const base =
    source.provider === 'github'
      ? 'https://github.com'
      : (source.gitlabUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
  const scmUrl = `${base}/${source.repo}.git`;
  // Jobs the connector may use: the guard on getJob is the `jobs` list.
  const jobsFor = async (branch?: string): Promise<string[]> => {
    const found = await call(finder, { scmUrl, ...(branch ? { branch } : {}) });
    return (Array.isArray(found) ? (found as { fullName?: unknown }[]) : [])
      .map((j) => (typeof j.fullName === 'string' ? j.fullName : ''))
      .filter((name) => name && allowed(getJob, { jobFullName: name }));
  };
  const lastBuild = async (job: string): Promise<LastBuild | null> => {
    const r = (await call(getJob, {
      jobFullName: job,
      tree: 'lastBuild[number,result,building,url]',
    })) as { lastBuild?: LastBuild | null } | undefined;
    return r?.lastBuild ?? null;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1. The job for the branch. A multibranch job finds it by webhook or on its next scan.
  ctx.term.out(`Looking for the Jenkins job that builds ${head}...`);
  let job: string | undefined;
  for (const until = Date.now() + t.discoverMs; ;) {
    job = (await jobsFor(head))[0];
    if (job || Date.now() >= until) break;
    await sleep(t.pollMs);
  }
  if (!job) {
    const others = await jobsFor();
    const listed = (runtime.inputs.find((x) => x.component.id === 'jenkins')?.component.settings[
      'jobs'
    ] ?? []) as string[];
    ctx.term.out(
      others.length > 0
        ? `Jenkins builds ${source.repo} in ${others.join(', ')}, but no job picked up ${head}. A multibranch pipeline job builds every branch: turn on a webhook or a periodic scan.`
        : `No Jenkins job in ${listed.join(', ')} builds ${source.repo}. Create a multibranch pipeline job for it there; it runs the Jenkinsfile in this pull request.`,
    );
    return;
  }

  // 2. Jenkins usually starts the build itself when it finds the branch; else ask to start it.
  let build = await lastBuild(job);
  for (const until = Date.now() + t.pollMs * 3; !build && Date.now() < until;) {
    await sleep(t.pollMs);
    build = await lastBuild(job);
  }
  let after = 0;
  if (!build) {
    const trigger = tools.get('triggerBuild');
    const args = { jobFullName: job };
    if (!trigger) {
      ctx.term.out(
        `Jenkins job ${job} has not built ${head} yet. With read-write-approved access, the agent can start it.`,
      );
      return;
    }
    const decision = decide(policyInputFor(trigger, args, destructive));
    if (decision.kind === 'block') {
      ctx.term.out(`Not starting ${job}: ${decision.reason}.`);
      return;
    }
    const rules = rulesFor(resolvePolicy(runtime.config.spec), {
      namespaces: [],
      repos: [source.repo],
    });
    if (!rules.ok) {
      ctx.term.out(`Not starting ${job}: ${rules.reason}.`);
      return;
    }
    const summary = ctx.redactor.redact(JSON.stringify(args));
    const outcome = await approveShipChange({
      ctx,
      runtime,
      approvals: i.hooks.approvals,
      requestedBy: i.hooks.requestedBy,
      task: i.task,
      connector: 'jenkins',
      tool: trigger.tool,
      risk: trigger.risk,
      args: summary,
      reason: `Start Jenkins job ${job} to build the pull request's branch ${head}.`,
      rules: rules.rules,
    });
    if (outcome.decision !== 'approved') {
      ctx.term.out(`Not approved: ${job} was not started.`);
      return;
    }
    let failed: boolean;
    try {
      failed = (await runtime.host.call(trigger.name, args)).isError;
    } catch {
      failed = true;
    }
    await runtime.audit.append({
      event: 'tool.call',
      actor: 'ship',
      task: i.task,
      connector: 'jenkins',
      tool: trigger.tool,
      risk: trigger.risk,
      decision: 'approved',
      detail: `${failed ? 'error' : 'ok'}; ${job}`,
    });
    if (failed) {
      ctx.term.err(`Could not start ${job}.`);
      return;
    }
    ctx.term.out(`Started ${job}.`);
  } else if (!build.building) {
    // A build that finished before the agent looked is this branch's: the job is new.
    after = build.number - 1;
  }

  // 3. Watch it to the end.
  ctx.term.out(`Watching ${job}...`);
  let done: LastBuild | null = null;
  for (const until = Date.now() + t.buildMs; Date.now() < until; await sleep(t.pollMs)) {
    const b = await lastBuild(job);
    if (b && b.number > after && !b.building) {
      done = b;
      break;
    }
  }
  if (!done) {
    ctx.term.out(`${job} is still building. Ask the agent to check it later.`);
    return;
  }
  await runtime.audit.append({
    event: 'result',
    actor: 'ship',
    task: i.task,
    detail: `jenkins ${job} #${String(done.number)}: ${done.result ?? 'unknown'}`,
  });
  if (done.result === 'SUCCESS') {
    ctx.term.out(`Jenkins built the pull request: ${done.url}`);
    return;
  }
  ctx.term.err(
    `Jenkins build ${job} #${String(done.number)} ended ${done.result ?? 'without a result'}: ${done.url}`,
  );
  const logTool = tools.get('getBuildLog');
  const log = logTool
    ? ((await call(logTool, { jobFullName: job, buildNumber: done.number, limit: -40 })) as
        { lines?: unknown } | undefined)
    : undefined;
  if (Array.isArray(log?.lines)) {
    ctx.term.err(ctx.redactor.redact((log.lines as unknown[]).map(String).join('\n')));
  }
}
