import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ciName, type CiSystem, type DeployTarget } from '@kodra-agent/templates';
import { policyInputFor } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import type { Context } from '../context.ts';
import { decide } from '../policy.ts';
import type { Runtime } from '../runtime.ts';
import { sandboxDeploy, sandboxSetup, type SandboxResult } from '../sandbox/sandbox.ts';
import { refuseAll } from './approve.ts';
import { proposeCiFix } from './ci-fix.ts';
import {
  CI_TIMINGS,
  watchHostCi,
  type CiOutcome,
  type CiReader,
  type CiTimings,
} from './ci-watch.ts';
import { findJenkinsJob, runJenkinsBuild } from './jenkins.ts';
import { AUTHOR, type Git } from './workspace.ts';

/**
 * After ship opens the pull request (B6), the agent keeps going like a DevOps engineer would:
 * it watches the pull request's CI to the end, fixes a failure in the files it added (up to
 * `maxFixes` commits, on that branch only, covered by the pull request's approval), says
 * where the problem is when it is in the application instead, tests the passing build in
 * the sandbox, and reports what is ready and what is left for a person.
 */
export interface FollowInput {
  ctx: Context;
  runtime: Runtime;
  configPath: string;
  source: { provider: 'github' | 'gitlab'; repo: string; gitlabUrl?: string };
  git: Git;
  repoDir: string;
  head: string;
  task: string;
  ci: CiSystem | null;
  /** Files ship added in this pull request: the only ones a fix may change. */
  generated: readonly string[];
  maxFixes: number;
  deploy: DeployTarget | null;
  hooks: {
    approvals?: ApprovalChannel;
    requestedBy?: string;
    post?: (text: string) => Promise<void>;
  };
  /** Pushes the branch's new commit; false when refused or failed. */
  push: () => Promise<boolean>;
}

export interface FollowResult {
  ci: { system: CiSystem | null; outcome: CiOutcome | null };
  /** One line per fix commit. */
  fixes: string[];
  /** When the cause is outside the files ship added. */
  diagnosis: { cause: string; fix: string } | null;
  sandbox: SandboxResult | null;
  /** Why the sandbox test did not run, if it did not. */
  sandboxSkipped: string | null;
}

export async function followPullRequest(i: FollowInput): Promise<FollowResult> {
  const { ctx, runtime } = i;
  const result: FollowResult = {
    ci: { system: i.ci, outcome: null },
    fixes: [],
    diagnosis: null,
    sandbox: null,
    sandboxSkipped: null,
  };
  if (!i.ci) return { ...result, sandboxSkipped: 'No CI builds this repo.' };
  const timings: CiTimings = { ...CI_TIMINGS, ...ctx.shipJenkins, ...ctx.shipCi };
  const reader = (connector: string): CiReader => ({ ctx, runtime, connector, timings });
  const sha = async () => (await i.git.run(['rev-parse', 'HEAD'], i.repoDir)).stdout.trim();

  // Jenkins needs its job first; it is found once and then built again after each fix.
  let job: string | null = null;
  if (i.ci === 'jenkins') {
    const found = await findJenkinsJob(reader('jenkins'), i.source, i.head);
    if (found.job === null) {
      ctx.term.out(found.message);
      result.ci.outcome = { kind: 'pending', message: found.message };
      return { ...result, sandboxSkipped: 'The CI run has not passed yet.' };
    }
    job = found.job;
  }
  let lastRun = 0;
  const watch = async (): Promise<CiOutcome> => {
    if (i.ci === 'jenkins' && job) {
      const name = job;
      const outcome = await runJenkinsBuild(reader('jenkins'), name, lastRun, () =>
        startJenkins(i, name),
      );
      if (outcome.kind !== 'pending') lastRun = Number(outcome.run);
      return outcome;
    }
    ctx.term.out(`Watching the ${ciName(i.ci as CiSystem)} run for ${i.head}...`);
    return watchHostCi(
      i.ci as Exclude<CiSystem, 'jenkins'>,
      { ctx, runtime, timings },
      {
        provider: i.source.provider,
        repo: i.source.repo,
        branch: i.head,
        sha: await sha(),
      },
    );
  };

  let outcome = await watch();
  for (;;) {
    result.ci.outcome = outcome;
    await runtime.audit.append({
      event: 'result',
      actor: 'ship',
      task: i.task,
      detail: `ci ${i.ci}: ${outcome.kind}${outcome.kind === 'pending' ? '' : ` ${outcome.url}`}`,
    });
    if (outcome.kind !== 'failed') break;
    ctx.term.err(`${ciName(i.ci)} run ${outcome.run} ended ${outcome.result}: ${outcome.url}`);
    ctx.term.err(ctx.redactor.redact(outcome.log.split('\n').slice(-25).join('\n')));
    ctx.term.out('Reading the failure...');
    const files = await Promise.all(
      i.generated.map(async (path) => ({
        path,
        content: await readFile(join(i.repoDir, path), 'utf8').catch(() => ''),
      })),
    );
    const deps = runtime.deps(refuseAll);
    const fix = await proposeCiFix(
      {
        model: deps.model,
        modelLabel: deps.modelLabel,
        redactor: ctx.redactor,
        audit: runtime.audit,
        task: i.task,
      },
      files.filter((f) => f.content),
      { ci: ciName(i.ci), result: outcome.result, log: outcome.log },
    );
    if (fix.kind === 'diagnosis') {
      result.diagnosis = { cause: fix.cause, fix: fix.fix };
      ctx.term.out(`Cause: ${fix.cause}`);
      ctx.term.out(`What to do: ${fix.fix}`);
      break;
    }
    if (fix.kind === 'none') {
      ctx.term.err(`No fix: ${fix.reason}.`);
      break;
    }
    if (result.fixes.length >= i.maxFixes) {
      ctx.term.err(
        `The model has a fix for ${fix.path} (${fix.change}), but the limit of ${String(i.maxFixes)} fix commit${i.maxFixes === 1 ? '' : 's'} is reached. Nothing more was pushed.`,
      );
      break;
    }
    ctx.term.out(`Fix ${String(result.fixes.length + 1)}: ${fix.path}: ${fix.change}`);
    await writeFile(join(i.repoDir, fix.path), fix.content, 'utf8');
    const identity = ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`];
    const message = `Fix ${fix.path} after the CI failure\n\n${fix.change}\n\nPrepared by Kodra AI Agent.`;
    const committed =
      (await i.git.run(['add', '--', fix.path], i.repoDir)).code === 0 &&
      (await i.git.run([...identity, 'commit', '--no-verify', '-m', message], i.repoDir)).code ===
        0;
    if (!committed || !(await i.push())) {
      ctx.term.err('The fix could not be pushed.');
      break;
    }
    result.fixes.push(
      `${fix.path}: ${fix.change} (after ${ciName(i.ci)} run ${outcome.run} failed)`,
    );
    outcome = await watch();
  }

  if (outcome.kind === 'passed') {
    ctx.term.out(`${ciName(i.ci)} passed: ${outcome.url}`);
    const setup = sandboxSetup(runtime);
    if (!setup.ok) {
      result.sandboxSkipped = setup.reason;
    } else if (i.deploy?.kind === 'vm') {
      result.sandboxSkipped = 'It deploys to a VM, so there is no Kubernetes sandbox test.';
    } else {
      ctx.term.out('Testing the build in the sandbox...');
      await sandboxDeploy(
        { configPath: i.configPath, repo: i.source.repo, branch: i.head, keepMs: 0 },
        ctx,
        {
          runtime,
          ...(i.hooks.approvals ? { approvals: i.hooks.approvals } : {}),
          ...(i.hooks.requestedBy ? { requestedBy: i.hooks.requestedBy } : {}),
          ...(i.hooks.post ? { post: i.hooks.post } : {}),
          onResult: (r) => {
            result.sandbox = r;
          },
        },
      ).catch((error: unknown) => {
        ctx.term.err(`The sandbox test failed to run: ${ctx.redactor.redact(String(error))}`);
      });
      if (!result.sandbox) result.sandboxSkipped = 'The sandbox test did not finish.';
    }
  } else if (outcome.kind === 'pending') {
    ctx.term.out(outcome.message);
    result.sandboxSkipped = 'The CI run has not passed yet.';
  } else {
    result.sandboxSkipped = 'The CI run failed.';
  }
  return result;
}

/**
 * Starts the job's build when Jenkins did not start it by itself. The pull request's approval
 * covered starting builds of its own branch; the policy engine still decides the call.
 */
async function startJenkins(
  i: FollowInput,
  job: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { ctx, runtime } = i;
  const trigger = runtime.host
    .tools()
    .find((t) => t.connector === 'jenkins' && t.tool === 'triggerBuild');
  if (!trigger) {
    return {
      ok: false,
      message: `Jenkins job ${job} has not built ${i.head} yet. With read-write-approved access, the agent can start it.`,
    };
  }
  const args = { jobFullName: job };
  const decision = decide(
    policyInputFor(trigger, args, runtime.config.spec.policy.destructiveActions),
  );
  if (decision.kind === 'block')
    return { ok: false, message: `Not starting ${job}: ${decision.reason}.` };
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
    detail: `${failed ? 'error' : 'ok'}; ${job}; covered by the pull request's approval`,
  });
  if (failed) return { ok: false, message: `Could not start ${job}.` };
  ctx.term.out(`Started ${job}.`);
  return { ok: true };
}

/** The end-of-run report: what is done, with links, and what is left for a person. */
export function followReport(o: {
  repo: string;
  prUrl: string | null;
  onboard: boolean;
  risks?: number | undefined;
  gaps?: number | undefined;
  follow: FollowResult;
  deploy: DeployTarget | null;
  todo: readonly string[];
}): { text: string; ready: boolean } {
  const f = o.follow;
  const out = f.ci.outcome;
  const ready = out?.kind === 'passed' && (f.sandbox === null || f.sandbox.passed);
  const lines = [
    `*${o.onboard ? 'Onboarding' : 'Shipping'} ${o.repo}: ${ready ? 'ready to merge' : out?.kind === 'failed' ? 'needs a person' : 'waiting'}*`,
  ];
  if (o.onboard && o.risks !== undefined) {
    lines.push(
      `• Report: ${String(o.risks)} risks, ${String(o.gaps ?? 0)} gaps (ONBOARDING.md in the pull request).`,
    );
  }
  if (o.prUrl) lines.push(`• Pull request: ${o.prUrl}`);
  if (f.ci.system) {
    const name = ciName(f.ci.system);
    lines.push(
      !out
        ? `• ${name}: not watched.`
        : out.kind === 'passed'
          ? `• ${name}: passed${f.fixes.length > 0 ? ` after ${String(f.fixes.length)} fix${f.fixes.length === 1 ? '' : 'es'}` : ''}: ${out.url}`
          : out.kind === 'failed'
            ? `• ${name}: failed (${out.result}): ${out.url}`
            : `• ${name}: ${out.message}`,
    );
  }
  for (const fix of f.fixes) lines.push(`  ◦ Fixed ${fix}`);
  if (f.diagnosis) {
    lines.push(`• Cause: ${f.diagnosis.cause}`, `• What to do: ${f.diagnosis.fix}`);
  }
  if (f.sandbox) {
    lines.push(
      `• Sandbox test: ${f.sandbox.passed ? 'passed' : 'failed'}${f.sandbox.keptUntil ? `, kept until ${f.sandbox.keptUntil}` : ', then destroyed'}.`,
    );
  } else if (f.sandboxSkipped && out?.kind === 'passed') {
    lines.push(`• Sandbox test: skipped. ${f.sandboxSkipped}`);
  }
  if (o.deploy) {
    const where =
      o.deploy.kind === 'kubernetes' ? `namespace ${o.deploy.namespace}` : o.deploy.host;
    lines.push(
      `• Deploy: once merged, the pipeline deploys to ${where}${o.deploy.when === 'manual' ? ' after a person approves it in the CI system' : ''}. Then ask me to watch the release (\`kodra-agent release ${o.repo}\`), and I check that it is healthy.`,
    );
  } else {
    lines.push(
      '• Deploy: no deploy stage. Set it under Settings, Connectors, Deploy (spec.ship.deploy) and onboard again to add one.',
    );
  }
  if (o.todo.length > 0) {
    lines.push('', '*Before merging*', ...o.todo.map((t) => `• ${t}`));
  }
  return { text: lines.join('\n'), ready };
}
