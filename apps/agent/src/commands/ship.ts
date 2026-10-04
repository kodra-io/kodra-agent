import { randomUUID } from 'node:crypto';
import { stat, mkdir, mkdtemp, readFile, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { detectStack, planShip, shipPrBody, type SourceProvider } from '@kodra-agent/templates';
import { policyInputFor } from '../agent.ts';
import { cliApprovalChannel, newApprovalRequest, type ApprovalChannel } from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { Context } from '../context.ts';
import type { HostedTool, ConnectorInput } from '../mcp/host.ts';
import { decide } from '../policy.ts';
import { startRuntime, type Runtime } from '../runtime.ts';
import { spawnExec } from '../ship/exec.ts';
import { proposeDockerfileFix } from '../ship/fix.ts';
import { buildImage, helmCheck, smokeTest, toolAvailable, type Check } from '../ship/verify.ts';
import { AUTHOR, copyLocal, Git, remoteUrl, repoFiles, writeEmptyFile } from '../ship/workspace.ts';

export interface ShipOptions {
  configPath: string;
  /** owner/repo (GitHub), group/project (GitLab), or a local folder. */
  target: string;
  /** Branch to start from and open the PR against (default: the repo's default branch). */
  branch?: string | undefined;
  /** How many times the model may fix a Dockerfile that fails to build or start. */
  maxFixes: number;
}

interface Source {
  provider: SourceProvider;
  /** As configured, e.g. acme/payments-api. */
  repo: string;
  input: ConnectorInput;
  gitlabUrl?: string;
}

const REPO = /^[\w.-]+(\/[\w.-]+)+$/;
const BUILD_TIMEOUT_MS = 20 * 60_000;

const settingList = (settings: Readonly<Record<string, unknown>>, key: string) =>
  Array.isArray(settings[key]) ? (settings[key] as unknown[]).map(String) : [];

function findSource(runtime: Runtime, target: string): Source | null {
  for (const input of runtime.inputs) {
    const id = input.component.id;
    if (id !== 'github' && id !== 'gitlab') continue;
    const repos = settingList(input.component.settings, id === 'github' ? 'repos' : 'projects');
    const repo = repos.find((r) => r.toLowerCase() === target.toLowerCase());
    if (!repo) continue;
    const url = input.component.settings['url'];
    return { provider: id, repo, input, ...(typeof url === 'string' ? { gitlabUrl: url } : {}) };
  }
  return null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Without a terminal there is nobody to approve, so the push is refused. */
const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'no-terminal' }),
};

/**
 * The ship flow (SPEC section 9): detect the stack, add what is missing from tested
 * templates, build and smoke-test the image (the model may fix a failing Dockerfile a few
 * times), lint the chart, then push a new branch and open a PR after one approval.
 */
export async function ship(opts: ShipOptions, ctx: Context): Promise<number> {
  const exec = ctx.exec ?? spawnExec;
  const localDir = (await isDirectory(opts.target)) ? resolve(opts.target) : null;
  if (!localDir && !REPO.test(opts.target)) {
    ctx.term.err(
      `'${opts.target}' is neither a folder nor a repo. Use owner/repo, group/project, or a local folder.`,
    );
    return 2;
  }

  const runtime = await startRuntime(opts.configPath, ctx);
  if (!runtime) return 1;
  const work = await mkdtemp(join(tmpdir(), 'kodra-ship-'));
  const task = `ship-${randomUUID().slice(0, 8)}`;
  try {
    let source: Source | null = null;
    if (!localDir) {
      source = findSource(runtime, opts.target);
      if (!source) {
        ctx.term.err(
          `${opts.target} is not in the configured GitHub repos or GitLab projects. Add it to kodra-agent.yaml first.`,
        );
        return 1;
      }
    }
    for (const tool of ['docker', 'helm'] as const) {
      if (!(await toolAvailable(exec, tool))) {
        ctx.term.err(
          tool === 'docker'
            ? 'Docker is needed to build and test the image. Start Docker and try again.'
            : 'Helm is needed to check the chart. Install Helm and try again.',
        );
        return 1;
      }
    }
    await runtime.audit.append({
      event: 'task.start',
      actor: 'ship',
      task,
      detail: localDir ? 'local folder' : `${source?.provider ?? ''} ${opts.target}`,
    });

    // 1. A working copy: a shallow clone, or a copy of the local folder.
    const repoDir = join(work, 'repo');
    const git = Git.create({
      exec,
      redactor: ctx.redactor,
      emptyConfig: await writeEmptyFile(join(work, 'gitconfig')),
      ...(source ? { provider: source.provider, token: source.input.secrets['token'] ?? '' } : {}),
    });
    let baseBranch = opts.branch ?? '';
    if (source) {
      const url =
        ctx.gitRemote?.(source.provider, source.repo) ??
        remoteUrl(source.provider, source.repo, source.gitlabUrl);
      ctx.term.out(`Cloning ${source.repo}${opts.branch ? ` (${opts.branch})` : ''}...`);
      const clone = await git.run([
        'clone',
        '--depth',
        '1',
        ...(opts.branch ? ['--branch', opts.branch] : []),
        url,
        repoDir,
      ]);
      if (clone.code !== 0) {
        ctx.term.err(`Could not clone ${source.repo}: ${clone.stderr.trim()}`);
        return 1;
      }
      if (!baseBranch) {
        baseBranch = (await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).stdout.trim();
      }
    } else if (localDir) {
      await copyLocal(localDir, repoDir);
    }

    // 2. Detect.
    const name = source?.repo ?? (localDir ?? 'app').split(/[\\/]/).filter(Boolean).at(-1) ?? 'app';
    const detected = detectStack(repoFiles(repoDir), name);
    if (!detected.ok) {
      ctx.term.err(detected.reason);
      return 1;
    }
    const d = detected.detection;
    ctx.term.out('Detected:');
    for (const note of d.notes) ctx.term.out(`  ${note}`);

    // 3. Generate what is missing.
    const ciProvider =
      source?.provider ??
      (runtime.inputs.some((i) => i.component.id === 'github')
        ? 'github'
        : runtime.inputs.some((i) => i.component.id === 'gitlab')
          ? 'gitlab'
          : null);
    const plan = planShip(d, {
      provider: ciProvider,
      repo: source?.repo ?? name,
      defaultBranch: baseBranch || 'main',
      ...(source?.gitlabUrl ? { gitlabUrl: source.gitlabUrl } : {}),
    });
    for (const kept of plan.kept) ctx.term.out(`  Keeping: ${kept}`);
    if (plan.files.length === 0) {
      ctx.term.out('Nothing to add: the Dockerfile, CI, and chart already exist.');
      return 0;
    }
    ctx.term.out('Adding:');
    for (const file of plan.files) {
      ctx.term.out(`  ${file.path}`);
      await mkdir(dirname(join(repoDir, file.path)), { recursive: true });
      await writeFile(join(repoDir, file.path), file.content, 'utf8');
    }

    // 4. Verify: build and smoke-test, letting the model fix a generated Dockerfile.
    const verification: string[] = [];
    const modelChanges: string[] = [];
    const image = `kodra-ship/${d.name}:${task.slice(5)}`;
    const verifyImage = async (): Promise<Check[]> => {
      ctx.term.out('Building the image...');
      const built = await buildImage(exec, repoDir, image, BUILD_TIMEOUT_MS);
      if (!built.ok) return [built];
      ctx.term.out('Starting the container...');
      const smoke = await smokeTest(exec, {
        image,
        port: d.port,
        healthPath: d.healthPath,
        timeoutMs: ctx.shipSmokeTimeoutMs ?? 120_000,
        fetch: ctx.fetch,
      });
      return [built, smoke];
    };
    let checks = await verifyImage();
    let attempt = 0;
    for (;;) {
      const failed = checks.find((c): c is Extract<Check, { ok: false }> => !c.ok);
      if (!failed) break;
      ctx.term.err(`Verification failed: ${failed.detail}.`);
      if (!plan.generatedDockerfile || attempt >= opts.maxFixes) {
        ctx.term.err(ctx.redactor.redact(failed.log.split('\n').slice(-30).join('\n')));
        ctx.term.err(
          plan.generatedDockerfile
            ? `Stopped after ${String(attempt)} fix attempt${attempt === 1 ? '' : 's'}. Nothing was pushed.`
            : 'The repo has its own Dockerfile, so it is not changed. Nothing was pushed.',
        );
        await audit(runtime.audit, task, 'stopped: verification failed');
        return 1;
      }
      attempt++;
      ctx.term.out(
        `Asking the model for a fix (attempt ${String(attempt)} of ${String(opts.maxFixes)})...`,
      );
      const deps = runtime.deps(refuseAll);
      const fix = await proposeDockerfileFix(
        {
          model: deps.model,
          modelLabel: deps.modelLabel,
          redactor: ctx.redactor,
          audit: runtime.audit,
          task,
        },
        await readFile(join(repoDir, 'Dockerfile'), 'utf8'),
        failed,
      );
      if (!fix.ok) {
        ctx.term.err(`No usable fix: ${fix.reason}.`);
        continue;
      }
      ctx.term.out(`  Change: ${fix.change}`);
      modelChanges.push(`Attempt ${String(attempt)}: ${fix.change} (after: ${failed.detail})`);
      await writeFile(join(repoDir, 'Dockerfile'), fix.dockerfile, 'utf8');
      checks = await verifyImage();
    }
    verification.push(...checks.map((c) => c.detail));

    // 5. Package: lint and render the chart.
    ctx.term.out('Checking the Helm chart...');
    const helm = await helmCheck(exec, repoDir, plan.chartDir);
    if (!helm.ok) {
      ctx.term.err(`${helm.detail}:\n${ctx.redactor.redact(helm.log)}`);
      await audit(runtime.audit, task, 'stopped: chart check failed');
      return 1;
    }
    verification.push(helm.detail);
    for (const line of verification) ctx.term.out(`  ${line}`);

    // 6. Ship: a local folder gets the files; a repo gets a branch and a PR.
    if (!source) {
      if (!localDir) return 1;
      for (const file of plan.files) {
        const to = join(localDir, file.path);
        if (await exists(to)) continue;
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(repoDir, file.path), to);
      }
      ctx.term.out(
        `Added ${String(plan.files.length)} files to ${localDir}. Review them and commit.`,
      );
      await audit(runtime.audit, task, 'files written locally');
      return 0;
    }
    const body = shipPrBody({ detection: d, plan, verification, modelChanges });
    return await openPullRequest({
      ctx,
      runtime,
      source,
      git,
      repoDir,
      baseBranch,
      plan,
      body,
      task,
    });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await runtime.close();
  }
}

async function audit(log: AuditLog, task: string, detail: string): Promise<void> {
  await log.append({ event: 'result', actor: 'ship', task, detail });
}

interface PrInput {
  ctx: Context;
  runtime: Runtime;
  source: Source;
  git: Git;
  repoDir: string;
  baseBranch: string;
  plan: { files: { path: string }[] };
  body: string;
  task: string;
}

const TITLE = 'Add a Dockerfile, CI, and a Helm chart';

/**
 * One approval covers both changes: pushing a new branch and opening the PR. The policy
 * engine decides each first, with the connector's own guards (repo allowlist, never the
 * default branch), so a blocked change is never offered for approval.
 */
async function openPullRequest(i: PrInput): Promise<number> {
  const { ctx, runtime, source, git, repoDir, task } = i;
  const github = source.provider === 'github';
  const display = github ? 'GitHub' : 'GitLab';
  const tools = runtime.host.tools();
  const find = (tool: string) =>
    tools.find((t) => t.connector === source.provider && t.tool === tool);
  const branchTool = find('create_branch');
  const prTool = find(github ? 'create_pull_request' : 'create_merge_request');
  if (!branchTool || !prTool) {
    ctx.term.err(
      `The ${display} connector needs read-write-approved access to open a pull request. Nothing was pushed.`,
    );
    await audit(runtime.audit, task, 'stopped: connector is read-only');
    return 1;
  }

  const head = `kodra-agent/ship-${task.slice(5)}`;
  const [owner = '', ...rest] = source.repo.split('/');
  const repoArgs = github ? { owner, repo: rest.join('/') } : { project_id: source.repo };
  const pushArgs = { ...repoArgs, branch: head };
  const prArgs = github
    ? { ...repoArgs, title: TITLE, body: i.body, head, base: i.baseBranch }
    : {
        ...repoArgs,
        title: TITLE,
        description: i.body,
        source_branch: head,
        target_branch: i.baseBranch,
      };

  const destructive = runtime.config.spec.policy.destructiveActions;
  for (const [tool, args] of [
    [branchTool, pushArgs],
    [prTool, prArgs],
  ] as [HostedTool, Record<string, unknown>][]) {
    const decision = decide(policyInputFor(tool, args, destructive));
    if (decision.kind === 'block') {
      ctx.term.err(`Blocked by policy (${tool.tool}): ${decision.reason}. Nothing was pushed.`);
      await runtime.audit.append({
        event: 'tool.call',
        actor: 'ship',
        task,
        connector: tool.connector,
        tool: tool.tool,
        risk: tool.risk,
        decision: 'blocked',
        detail: decision.reason,
      });
      return 1;
    }
  }

  // Commit locally first, so nothing is asked for if the commit itself fails.
  const files = i.plan.files.map((f) => f.path);
  const identity = ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`];
  for (const args of [
    ['checkout', '-b', head],
    ['add', '--', ...files],
    [...identity, 'commit', '--no-verify', '-m', `${TITLE}\n\nPrepared by Kodra AI Agent.`],
  ]) {
    const result = await git.run(args, repoDir);
    if (result.code !== 0) {
      ctx.term.err(
        `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${result.stderr.trim()}`,
      );
      return 1;
    }
  }

  const summary = ctx.redactor.redact(
    JSON.stringify({ repo: source.repo, branch: head, base: i.baseBranch, title: TITLE, files }),
  );
  const req = newApprovalRequest(
    {
      connector: source.provider,
      tool: `git push + ${prTool.tool}`,
      risk: 'write',
      args: summary,
      reason:
        'Ship: push the verified Dockerfile, CI, and Helm chart to a new branch and open a pull request.',
      requestedBy: 'ship',
    },
    runtime.config.spec.policy.approvals.expiresAfterMinutes,
  );
  const base = { actor: 'ship', task, connector: source.provider, risk: 'write' } as const;
  await runtime.audit.append({
    ...base,
    event: 'approval.request',
    tool: req.tool,
    detail: `${req.id}; args ${summary}`,
  });
  const approvals = ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll;
  const outcome = await approvals.request(req);
  await runtime.audit.append({
    ...base,
    event: 'approval.decision',
    tool: req.tool,
    actor: outcome.decision === 'expired' ? 'ship' : outcome.by,
    decision: outcome.decision,
    detail: req.id,
  });
  if (outcome.decision !== 'approved') {
    ctx.term.err(
      outcome.decision === 'expired'
        ? 'The approval expired. Nothing was pushed.'
        : `Not approved${ctx.prompter ? '' : ' (no terminal to ask on)'}. Nothing was pushed.`,
    );
    return 1;
  }

  ctx.term.out(`Pushing ${head}...`);
  const push = await git.run(['push', 'origin', `refs/heads/${head}:refs/heads/${head}`], repoDir);
  await runtime.audit.append({
    ...base,
    event: 'tool.call',
    tool: 'git push',
    decision: 'approved',
    detail: `${push.code === 0 ? 'ok' : 'error'}; branch ${head}`,
  });
  if (push.code !== 0) {
    ctx.term.err(`git push failed: ${push.stderr.trim()}`);
    return 1;
  }

  ctx.term.out(`Opening the ${github ? 'pull request' : 'merge request'}...`);
  let text: string;
  let failed: boolean;
  try {
    const result = await runtime.host.call(prTool.name, prArgs);
    text = result.text;
    failed = result.isError;
  } catch (error) {
    text = error instanceof Error ? error.message : String(error);
    failed = true;
  }
  await runtime.audit.append({
    ...base,
    event: 'tool.call',
    tool: prTool.tool,
    decision: 'approved',
    detail: `${failed ? 'error' : 'ok'}; head ${head}, base ${i.baseBranch}`,
  });
  if (failed) {
    ctx.term.err(`The branch ${head} is pushed, but opening the pull request failed: ${text}`);
    return 1;
  }
  const url = /https?:\/\/[^\s"'<>]+\/(?:pull|merge_requests)\/\d+/.exec(text)?.[0];
  ctx.term.out(
    url ? `Opened: ${url}` : `Opened a ${github ? 'pull' : 'merge'} request from ${head}.`,
  );
  await audit(runtime.audit, task, `opened ${url ?? head}`);
  return 0;
}
