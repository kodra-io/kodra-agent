import type { CiSystem } from '@kodra-agent/templates';
import { policyInputFor } from '../agent.ts';
import type { Context } from '../context.ts';
import type { HostedTool } from '../mcp/host.ts';
import { decide } from '../policy.ts';
import type { Runtime } from '../runtime.ts';

/**
 * Watching a branch's CI run through the CI connector (B6), the same way for every CI tool:
 * find the run for a commit, wait for it to end, and on failure read the end of the log.
 * Reads only: starting a Jenkins build is done by the caller, after its approval.
 * Every call goes through the policy engine with the connector's guards, like the model's.
 */

/** How long to wait for a run to appear, for it to end, and between looks. */
export interface CiTimings {
  discoverMs: number;
  buildMs: number;
  pollMs: number;
}

export const CI_TIMINGS: CiTimings = {
  discoverMs: 5 * 60_000,
  buildMs: 30 * 60_000,
  pollMs: 10_000,
};

export type CiOutcome =
  | { kind: 'passed'; url: string; run: string }
  | { kind: 'failed'; url: string; run: string; result: string; log: string }
  /** No run was found, or it was still running when the wait ended. */
  | { kind: 'pending'; message: string };

export interface CiReader {
  ctx: Context;
  runtime: Runtime;
  connector: string;
  timings: CiTimings;
}

/** Log lines given to the model and the report: the end is where a failure shows. */
export const LOG_TAIL_CHARS = 6_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The plugin and server answers: JSON, sometimes wrapped as `{message, result}`. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function tail(text: string, chars = LOG_TAIL_CHARS): string {
  return text.length > chars ? `...${text.slice(-chars)}` : text;
}

/** The connector's tools by name, and a guarded call that returns null when refused or failed. */
export function toolbox(r: CiReader) {
  const tools = new Map(
    r.runtime.host
      .tools()
      .filter((x) => x.connector === r.connector)
      .map((x) => [x.tool, x]),
  );
  const destructive = r.runtime.config.spec.policy.destructiveActions;
  const allowed = (tool: HostedTool, args: Record<string, unknown>) =>
    decide(policyInputFor(tool, args, destructive)).kind !== 'block';
  const call = async (name: string, args: Record<string, unknown>): Promise<string | null> => {
    const tool = tools.get(name);
    if (!tool || !allowed(tool, args)) return null;
    try {
      const res = await r.runtime.host.call(tool.name, args);
      return res.isError ? null : res.text;
    } catch {
      return null;
    }
  };
  return { tools, allowed, call };
}

export interface WatchTarget {
  provider: 'github' | 'gitlab';
  /** owner/repo or group/project. */
  repo: string;
  branch: string;
  /** The commit whose run counts. */
  sha: string;
}

/**
 * GitHub Actions: the runs of the branch for the commit, until all of them end. On failure,
 * the end of the failed jobs' logs.
 */
export async function watchGithubActions(r: CiReader, t: WatchTarget): Promise<CiOutcome> {
  const { call, tools } = toolbox(r);
  if (!tools.has('actions_list')) {
    return {
      kind: 'pending',
      message:
        'The GitHub Actions connector is off, so the agent cannot watch the run. Check the pull request.',
    };
  }
  const [owner = '', ...rest] = t.repo.split('/');
  const repo = rest.join('/');
  interface Run {
    id: number;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    name?: string;
  }
  const runs = async (): Promise<Run[]> => {
    const text = await call('actions_list', {
      method: 'list_workflow_runs',
      owner,
      repo,
      workflow_runs_filter: { branch: t.branch },
      perPage: 20,
    });
    const body = text ? (parseJson(text) as { workflow_runs?: Run[] } | undefined) : undefined;
    return (body?.workflow_runs ?? []).filter((x) => x.head_sha === t.sha);
  };
  const started = Date.now();
  let found: Run[];
  for (;;) {
    found = await runs();
    if (found.length > 0 || Date.now() - started >= r.timings.discoverMs) break;
    await sleep(r.timings.pollMs);
  }
  if (found.length === 0) {
    return {
      kind: 'pending',
      message: `No GitHub Actions run started for ${t.branch}. Check that Actions is turned on for ${t.repo}.`,
    };
  }
  for (const until = Date.now() + r.timings.buildMs; ;) {
    if (found.every((x) => x.status === 'completed')) break;
    if (Date.now() >= until) {
      return { kind: 'pending', message: `The run for ${t.branch} is still going.` };
    }
    await sleep(r.timings.pollMs);
    found = await runs();
  }
  const bad = found.find((x) => x.conclusion !== 'success' && x.conclusion !== 'skipped');
  const first = found[0];
  if (!bad) {
    return { kind: 'passed', url: first?.html_url ?? '', run: String(first?.id ?? '') };
  }
  const logs = await call('get_job_logs', {
    owner,
    repo,
    run_id: bad.id,
    failed_only: true,
    return_content: true,
    tail_lines: 120,
  });
  return {
    kind: 'failed',
    url: bad.html_url ?? '',
    run: String(bad.id),
    result: bad.conclusion ?? 'failure',
    log: tail(logs ?? 'The log could not be read.'),
  };
}

/**
 * GitLab CI: the pipeline for the commit, until it ends. On failure, the end of the failed
 * jobs' logs where the server offers them (the community server), else the jobs' names.
 */
export async function watchGitlabCi(r: CiReader, t: WatchTarget): Promise<CiOutcome> {
  const { call, tools } = toolbox(r);
  if (!tools.has('list_pipelines')) {
    return {
      kind: 'pending',
      message:
        'The GitLab CI connector is off, so the agent cannot watch the pipeline. Check the merge request.',
    };
  }
  // The community server names the project `project_id`; GitLab's built-in one, `id`.
  const community = tools.has('list_pipeline_jobs');
  const project = community ? { project_id: t.repo } : { id: t.repo };
  interface Pipeline {
    id: number;
    sha?: string;
    status?: string;
    web_url?: string;
  }
  const pipeline = async (): Promise<Pipeline | undefined> => {
    const text = await call('list_pipelines', { ...project, per_page: 20 });
    const body = text ? parseJson(text) : undefined;
    const items = Array.isArray(body)
      ? (body as Pipeline[])
      : ((body as { items?: Pipeline[] } | undefined)?.items ?? []);
    return items.find((p) => p.sha === t.sha);
  };
  const DONE = ['success', 'failed', 'canceled', 'skipped', 'manual'];
  const started = Date.now();
  let p: Pipeline | undefined;
  for (;;) {
    p = await pipeline();
    if (p || Date.now() - started >= r.timings.discoverMs) break;
    await sleep(r.timings.pollMs);
  }
  if (!p) {
    return { kind: 'pending', message: `No pipeline started for ${t.branch}.` };
  }
  for (const until = Date.now() + r.timings.buildMs; !DONE.includes(p.status ?? '');) {
    if (Date.now() >= until) {
      return { kind: 'pending', message: `The pipeline for ${t.branch} is still running.` };
    }
    await sleep(r.timings.pollMs);
    p = (await pipeline()) ?? p;
  }
  // A manual deploy job waiting for a person still means the build passed.
  if (p.status === 'success' || p.status === 'manual' || p.status === 'skipped') {
    return { kind: 'passed', url: p.web_url ?? '', run: String(p.id) };
  }
  let log = `Pipeline ${String(p.id)} ended ${p.status ?? 'without a status'}.`;
  if (community) {
    const jobsText = await call('list_pipeline_jobs', { project_id: t.repo, pipeline_id: p.id });
    const jobs = (jobsText ? parseJson(jobsText) : undefined) as
      { id: number; name?: string; status?: string }[] | undefined;
    const failed = (Array.isArray(jobs) ? jobs : []).filter((j) => j.status === 'failed');
    const parts: string[] = [];
    for (const job of failed.slice(0, 2)) {
      const out = await call('get_pipeline_job_output', { project_id: t.repo, job_id: job.id });
      parts.push(`Job ${job.name ?? String(job.id)} failed:\n${tail(out ?? '', 3_000)}`);
    }
    if (parts.length > 0) log = parts.join('\n\n');
  }
  return {
    kind: 'failed',
    url: p.web_url ?? '',
    run: String(p.id),
    result: p.status ?? 'failed',
    log: tail(log),
  };
}

/** The watcher for a CI tool that is not Jenkins (Jenkins needs a job; see jenkins.ts). */
export function watchHostCi(
  ci: Exclude<CiSystem, 'jenkins'>,
  r: Omit<CiReader, 'connector'>,
  t: WatchTarget,
): Promise<CiOutcome> {
  return ci === 'github-actions'
    ? watchGithubActions({ ...r, connector: 'github-actions' }, t)
    : watchGitlabCi({ ...r, connector: 'gitlab-ci' }, t);
}
