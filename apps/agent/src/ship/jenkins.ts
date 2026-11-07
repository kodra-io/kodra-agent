import { parseJson, sleep, tail, toolbox, type CiOutcome, type CiReader } from './ci-watch.ts';

interface LastBuild {
  number: number;
  result: string | null;
  building: boolean;
  url: string;
}

/** The plugin wraps every answer as `{message, result}`; no `result` means nothing found. */
function resultOf(text: string | null): unknown {
  return text ? (parseJson(text) as { result?: unknown } | undefined)?.result : undefined;
}

export type JobLookup = { job: string } | { job: null; message: string };

/**
 * The Jenkins job that builds a branch (B5): found by the repo's git URL with the official
 * plugin's `findJobsWithScmUrl`, and only among the jobs the connector may use. A multibranch
 * job finds a new branch by webhook or on its next scan, so this waits for it.
 */
export async function findJenkinsJob(
  r: CiReader,
  source: { provider: 'github' | 'gitlab'; repo: string; gitlabUrl?: string },
  branch: string,
): Promise<JobLookup> {
  const { tools, allowed, call } = toolbox(r);
  const getJob = tools.get('getJob');
  if (!tools.has('findJobsWithScmUrl') || !getJob) {
    return {
      job: null,
      message:
        'Jenkins builds this pull request once a job picks up its branch. Ask the agent to start or check the build.',
    };
  }
  const base =
    source.provider === 'github'
      ? 'https://github.com'
      : (source.gitlabUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
  const scmUrl = `${base}/${source.repo}.git`;
  const jobsFor = async (b?: string): Promise<string[]> => {
    const found = resultOf(
      await call('findJobsWithScmUrl', { scmUrl, ...(b ? { branch: b } : {}) }),
    );
    return (Array.isArray(found) ? (found as { fullName?: unknown }[]) : [])
      .map((j) => (typeof j.fullName === 'string' ? j.fullName : ''))
      .filter((name) => name && allowed(getJob, { jobFullName: name }));
  };
  r.ctx.term.out(`Looking for the Jenkins job that builds ${branch}...`);
  for (const until = Date.now() + r.timings.discoverMs; ;) {
    const job = (await jobsFor(branch))[0];
    if (job) return { job };
    if (Date.now() >= until) break;
    await sleep(r.timings.pollMs);
  }
  const others = await jobsFor();
  const listed = (r.runtime.inputs.find((x) => x.component.id === 'jenkins')?.component.settings[
    'jobs'
  ] ?? []) as string[];
  return {
    job: null,
    message:
      others.length > 0
        ? `Jenkins builds ${source.repo} in ${others.join(', ')}, but no job picked up ${branch}. A multibranch pipeline job builds every branch: turn on a webhook or a periodic scan.`
        : `No Jenkins job in ${listed.join(', ')} builds ${source.repo}. Create a multibranch pipeline job for it there; it runs the Jenkinsfile in this pull request.`,
  };
}

/** The job's last build, or null. */
export async function lastJenkinsBuild(r: CiReader, job: string): Promise<LastBuild | null> {
  const { call } = toolbox(r);
  const res = resultOf(
    await call('getJob', { jobFullName: job, tree: 'lastBuild[number,result,building,url]' }),
  ) as { lastBuild?: LastBuild | null } | undefined;
  return res?.lastBuild ?? null;
}

/**
 * Waits for a build of `job` numbered above `after` (Jenkins starts one by itself when it
 * finds a new commit), else calls `start` (the caller's approved trigger), then watches it to
 * the end. On failure, the end of its log.
 */
export async function runJenkinsBuild(
  r: CiReader,
  job: string,
  after: number,
  start: () => Promise<{ ok: true } | { ok: false; message: string }>,
): Promise<CiOutcome> {
  const { call } = toolbox(r);
  const fresh = (b: LastBuild | null): b is LastBuild => b !== null && b.number > after;
  let build = await lastJenkinsBuild(r, job);
  for (const until = Date.now() + r.timings.pollMs * 3; !fresh(build) && Date.now() < until;) {
    await sleep(r.timings.pollMs);
    build = await lastJenkinsBuild(r, job);
  }
  if (!fresh(build)) {
    const started = await start();
    if (!started.ok) return { kind: 'pending', message: started.message };
  }
  r.ctx.term.out(`Watching ${job}...`);
  let done: LastBuild | null = null;
  for (
    const until = Date.now() + r.timings.buildMs;
    Date.now() < until;
    await sleep(r.timings.pollMs)
  ) {
    const b = await lastJenkinsBuild(r, job);
    if (fresh(b) && !b.building) {
      done = b;
      break;
    }
  }
  if (!done)
    return {
      kind: 'pending',
      message: `${job} is still building. Ask the agent to check it later.`,
    };
  if (done.result === 'SUCCESS') return { kind: 'passed', url: done.url, run: String(done.number) };
  const log = resultOf(
    await call('getBuildLog', { jobFullName: job, buildNumber: done.number, limit: -80 }),
  ) as { lines?: unknown } | undefined;
  return {
    kind: 'failed',
    url: done.url,
    run: String(done.number),
    result: done.result ?? 'without a result',
    log: tail(Array.isArray(log?.lines) ? (log.lines as unknown[]).map(String).join('\n') : ''),
  };
}
