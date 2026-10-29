import { randomUUID } from 'node:crypto';
import { stat, mkdir, mkdtemp, readFile, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  analyzeRepo,
  detectStack,
  onboardingReport,
  planShip,
  shipPrBody,
  type Analysis,
  type PlanOptions,
  type ShipFile,
  type SourceProvider,
} from '@kodra-agent/templates';
import { resolvePolicy } from '@kodra-agent/schema';
import { policyInputFor, recordOverride } from '../agent.ts';
import {
  cliApprovalChannel,
  decisionAudit,
  newApprovalRequest,
  rulesFor,
  type ApprovalChannel,
} from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { Context } from '../context.ts';
import type { HostedTool, ConnectorInput } from '../mcp/host.ts';
import { proxyOptions } from '../network.ts';
import { decide } from '../policy.ts';
import { TOKEN_PATTERNS } from '../redactor.ts';
import { startRuntime, type Runtime } from '../runtime.ts';
import { boltSlack } from '../slack/api.ts';
import { spawnExec } from '../ship/exec.ts';
import { proposeDockerfileFix } from '../ship/fix.ts';
import { pipelineInputs } from '../ship/pipeline.ts';
import {
  buildImage,
  helmCheck,
  selfContainer,
  smokeTest,
  toolAvailable,
  type Check,
} from '../ship/verify.ts';
import { AUTHOR, copyLocal, Git, remoteUrl, repoFiles, writeEmptyFile } from '../ship/workspace.ts';

export interface ShipOptions {
  configPath: string;
  /** owner/repo (GitHub), group/project (GitLab), or a local folder. */
  target: string;
  /** Branch to start from and open the PR against (default: the repo's default branch). */
  branch?: string | undefined;
  /** How many times the model may fix a Dockerfile that fails to build or start. */
  maxFixes: number;
  /** `onboard`: analyze the repo first, report, and add ONBOARDING.md to the PR (M26). */
  onboard?: boolean;
}

/**
 * How the console runs ship and onboard inside the running agent (M30a): its runtime, its
 * approvals (console and Slack), and its Slack channel. The agent has no Docker socket
 * (M14), so the image is not built here: `verify: 'ci'` opens the PR for the repo's CI to
 * build, and says so in it.
 */
export interface ShipHooks {
  runtime?: Runtime;
  approvals?: ApprovalChannel;
  /** 'local' builds and smoke-tests the image first (the CLI); 'ci' leaves that to the PR. */
  verify?: 'local' | 'ci';
  /** Onboard: stop after the report and the Slack post. */
  reportOnly?: boolean;
  /** Posts to the team's channel; the CLI opens its own Slack connection instead. */
  post?: (text: string) => Promise<void>;
  /** Who asked, for the approval request (a console user). */
  requestedBy?: string;
  /** What came out of it, as it happens: the report, then the PR. */
  onResult?: (result: ShipResult) => void;
}

export interface ShipResult {
  report?: string;
  /** Whether the stack can be shipped (else the report is all there is). */
  shippable?: boolean;
  risks?: number;
  gaps?: number;
  prUrl?: string;
}

export interface Source {
  provider: SourceProvider;
  /** As configured, e.g. acme/payments-api. */
  repo: string;
  input: ConnectorInput;
  gitlabUrl?: string;
}

const REPO = /^[\w.-]+(\/[\w.-]+)+$/;
const BUILD_TIMEOUT_MS = 20 * 60_000;

export const settingList = (settings: Readonly<Record<string, unknown>>, key: string) =>
  Array.isArray(settings[key]) ? (settings[key] as unknown[]).map(String) : [];

export function findSource(runtime: Runtime, target: string): Source | null {
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
export async function ship(
  opts: ShipOptions,
  ctx: Context,
  hooks: ShipHooks = {},
): Promise<number> {
  const local = (hooks.verify ?? 'local') === 'local';
  const baseExec = ctx.exec ?? spawnExec;
  // git, helm, and docker get the proxy and CA settings too (M12), once the runtime is up.
  let networkEnv: Readonly<Record<string, string>> = {};
  const exec: typeof baseExec = (command, args, o = {}) =>
    baseExec(command, args, { ...o, env: { ...networkEnv, ...o.env } });
  const localDir = (await isDirectory(opts.target)) ? resolve(opts.target) : null;
  if (!localDir && !REPO.test(opts.target)) {
    ctx.term.err(
      `'${opts.target}' is neither a folder nor a repo. Use owner/repo, group/project, or a local folder.`,
    );
    return 2;
  }

  const runtime = hooks.runtime ?? (await startRuntime(opts.configPath, ctx));
  if (!runtime) return 1;
  networkEnv = runtime.networkEnv;
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
    // Inside the agent container, the app under test is reached over a private network.
    const self = ctx.selfContainer === undefined ? selfContainer() : ctx.selfContainer;
    const toolsReady = async (): Promise<boolean> => {
      // Verified in the PR's CI: nothing to build here, and the chart is checked if Helm is.
      if (!local) return true;
      for (const tool of ['docker', 'helm'] as const) {
        if (!(await toolAvailable(exec, tool))) {
          ctx.term.err(
            tool === 'docker'
              ? self
                ? 'Docker is needed to build and test the image. In the agent container, turn on the Docker connector with build access, so the bundle mounts the Docker socket.'
                : 'Docker is needed to build and test the image. Start Docker and try again.'
              : 'Helm is needed to check the chart. Install Helm and try again.',
          );
          return false;
        }
      }
      return true;
    };
    // Onboarding reports first, so a machine without Docker still gets the report.
    if (!opts.onboard && !(await toolsReady())) return 1;
    const where = localDir ? 'local folder' : `${source?.provider ?? ''} ${opts.target}`;
    await runtime.audit.append({
      event: 'task.start',
      actor: 'ship',
      task,
      detail: opts.onboard ? `onboard: ${where}` : where,
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

    // 2. Detect, and when onboarding, analyze and report first.
    const name = source?.repo ?? (localDir ?? 'app').split(/[\\/]/).filter(Boolean).at(-1) ?? 'app';
    let analysis: Analysis | null = null;
    let report = '';
    if (opts.onboard) {
      analysis = analyzeRepo(repoFiles(repoDir), name, TOKEN_PATTERNS);
      report = onboardingReport(name, analysis);
      ctx.term.out(report);
      hooks.onResult?.({
        report,
        shippable: analysis.detection.ok,
        risks: analysis.findings.filter((f) => f.level === 'risk').length,
        gaps: analysis.findings.filter((f) => f.level === 'gap').length,
      });
      if (hooks.post) {
        await hooks.post(ctx.redactor.redact(slackSummary(name, analysis))).catch(() => undefined);
      } else await postToSlack(ctx, runtime, slackSummary(name, analysis));
      if (hooks.reportOnly) {
        await audit(runtime.audit, task, 'onboard: report');
        return 0;
      }
      if (!analysis.detection.ok) {
        ctx.term.out('Nothing was shipped: answer the questions above, then run onboard again.');
        await audit(runtime.audit, task, 'onboard: report only, stack not supported');
        return 0;
      }
      if (!(await toolsReady())) return 1;
    }
    const detected = analysis?.detection ?? detectStack(repoFiles(repoDir), name);
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
    // B1: a standalone pipeline, or a caller of the shared one the other repos use.
    const hasCi = source?.provider === 'github' ? d.existing.githubCi : d.existing.gitlabCi;
    let pipeline: PlanOptions['pipeline'];
    if (source && !hasCi) {
      const { provider, input } = source;
      ctx.term.out('Reading how the other repos are built...');
      pipeline = await pipelineInputs(git, work, {
        provider,
        repo: source.repo,
        settings: input.component.settings,
        configured: settingList(
          input.component.settings,
          provider === 'github' ? 'repos' : 'projects',
        ),
        remote: (repo) =>
          ctx.gitRemote?.(provider, repo) ?? remoteUrl(provider, repo, source.gitlabUrl),
      });
      await audit(
        runtime.audit,
        task,
        `pipeline: read the CI of ${String(pipeline.others.length)} other repos${pipeline.spec ? ' and the shared template' : ''}`,
      );
    }
    const plan = planShip(d, {
      provider: ciProvider,
      repo: source?.repo ?? name,
      defaultBranch: baseBranch || 'main',
      ...(source?.gitlabUrl ? { gitlabUrl: source.gitlabUrl } : {}),
      mirrors: runtime.config.spec.ship.baseImageMirrors,
      ...(analysis ? { env: envNames(analysis) } : {}),
      ...(pipeline ? { pipeline } : {}),
    });
    if (plan.pipeline) {
      ctx.term.out(
        plan.pipeline.mode === 'shared'
          ? `Pipeline: calls the shared ${plan.pipeline.template}. ${plan.pipeline.reason}`
          : `Pipeline: standalone. ${plan.pipeline.reason}`,
      );
      if (plan.pipeline.mode === 'shared') {
        for (const t of plan.pipeline.todo)
          ctx.term.out(`  Set before merging: ${t.name} (${t.why})`);
      }
    }
    let reportPath: string | null = null;
    if (analysis) {
      if (await exists(join(repoDir, REPORT))) {
        plan.kept.push(
          `${REPORT}: the existing one is left alone; the report is in this description.`,
        );
      } else {
        reportPath = REPORT;
        plan.files.push(reportFile(report));
      }
    }
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
        selfContainer: self,
      });
      return [built, smoke];
    };
    let checks: Check[] = local ? await verifyImage() : [];
    if (!local) {
      verification.push(
        'Not built by the agent: it has no Docker access. Check that this pull request builds in CI before merging.',
      );
    }
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
    if (local || (await toolAvailable(exec, 'helm'))) {
      ctx.term.out('Checking the Helm chart...');
      const helm = await helmCheck(exec, repoDir, plan.chartDir);
      if (!helm.ok) {
        ctx.term.err(`${helm.detail}:\n${ctx.redactor.redact(helm.log)}`);
        await audit(runtime.audit, task, 'stopped: chart check failed');
        return 1;
      }
      verification.push(helm.detail);
    } else verification.push('The chart was not linted here: Helm is not available.');
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
    const body = shipPrBody({
      detection: d,
      plan,
      verification,
      modelChanges,
      ...(analysis
        ? {
            onboarding: {
              reportPath,
              questions: analysis.questions,
              secrets: envNames(analysis).secrets,
            },
          }
        : {}),
    });
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
      onboard: opts.onboard ?? false,
      local,
      hooks,
    });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    if (!hooks.runtime) await runtime.close();
  }
}

const REPORT = 'ONBOARDING.md';

const reportFile = (report: string): ShipFile => ({
  path: REPORT,
  content: report,
  reason: 'The onboarding report: dependencies, settings, risks, gaps, and questions for the team.',
});

const envNames = (a: Analysis) => ({
  settings: a.config.filter((v) => !v.secret).map((v) => v.name),
  secrets: a.config.filter((v) => v.secret).map((v) => v.name),
});

/** Risks and questions for the team's Slack channel: names and locations only, never values. */
function slackSummary(repo: string, a: Analysis): string {
  const risks = a.findings.filter((f) => f.level === 'risk');
  const gaps = a.findings.filter((f) => f.level === 'gap');
  const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  return [
    `*Onboarding ${repo}*: ${plural(risks.length, 'risk')}, ${plural(gaps.length, 'gap')}.`,
    ...(risks.length > 0 ? ['', '*Risks*', ...risks.map((f) => `• ${f.text}`)] : []),
    ...a.secrets.map(
      (h) => `• Committed credential (${h.rule}) at \`${h.path}:${String(h.line)}\``,
    ),
    '',
    '*Questions for the team*',
    ...a.questions.map((q, i) => `${String(i + 1)}. ${q}`),
  ].join('\n');
}

/** Posts to the agent's Slack channel when Slack is configured. A failure only warns. */
export async function postToSlack(
  ctx: Context,
  runtime: Runtime,
  text: string,
  what = 'the risks and questions',
): Promise<void> {
  const input = runtime.inputs.find((i) => i.component.id === 'slack');
  const botToken = input?.secrets['botToken'];
  const appToken = input?.secrets['appToken'];
  if (!input || !botToken || !appToken) return;
  const channel = String(input.component.settings['channel']);
  try {
    const slack = (ctx.slackConnection ?? boltSlack)(
      botToken,
      appToken,
      proxyOptions(runtime.network),
    );
    await slack.api.postMessage({ channel, text: ctx.redactor.redact(text) });
    ctx.term.out(`Posted ${what} to Slack (${channel}).`);
  } catch (error) {
    ctx.term.err(
      `Could not post to Slack: ${ctx.redactor.redact(error instanceof Error ? error.message : String(error))}`,
    );
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
  onboard: boolean;
  /** Whether the image was built and tested here. */
  local: boolean;
  hooks: ShipHooks;
}

const TITLE = 'Add a Dockerfile, CI, and a Helm chart';
const ONBOARD_TITLE = 'Onboard this service: Dockerfile, CI, Helm chart, and a report';

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

  const title = i.onboard ? ONBOARD_TITLE : TITLE;
  const head = `kodra-agent/${i.onboard ? 'onboard' : 'ship'}-${task.slice(5)}`;
  const [owner = '', ...rest] = source.repo.split('/');
  const repoArgs = github ? { owner, repo: rest.join('/') } : { project_id: source.repo };
  const pushArgs = { ...repoArgs, branch: head };
  const prArgs = github
    ? { ...repoArgs, title, body: i.body, head, base: i.baseBranch }
    : {
        ...repoArgs,
        title,
        description: i.body,
        source_branch: head,
        target_branch: i.baseBranch,
      };

  const destructive = runtime.config.spec.policy.destructiveActions;
  // The push and the pull request go to one repo, so one environment's rules apply.
  const rules = rulesFor(resolvePolicy(runtime.config.spec), {
    namespaces: [],
    repos: [source.repo],
  });
  if (!rules.ok) {
    ctx.term.err(`Blocked by policy: ${rules.reason}. Nothing was pushed.`);
    return 1;
  }
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
    [...identity, 'commit', '--no-verify', '-m', `${title}\n\nPrepared by Kodra AI Agent.`],
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
    JSON.stringify({ repo: source.repo, branch: head, base: i.baseBranch, title, files }),
  );
  const req = newApprovalRequest(
    {
      connector: source.provider,
      tool: `git push + ${prTool.tool}`,
      risk: 'write',
      args: summary,
      reason: `${i.onboard ? 'Onboard' : 'Ship'}: push the ${i.local ? 'verified ' : ''}Dockerfile, CI, Helm chart${i.onboard ? ', and onboarding report' : ''} to a new branch and open a pull request.${i.local ? '' : " The image was not built by the agent: the pull request's CI builds it."}`,
      requestedBy: i.hooks.requestedBy ?? 'ship',
    },
    rules.rules,
  );
  const base = { actor: 'ship', task, connector: source.provider, risk: 'write' } as const;
  await runtime.audit.append({
    ...base,
    event: 'approval.request',
    tool: req.tool,
    detail: `${req.id}; args ${summary}`,
  });
  const approvals =
    i.hooks.approvals ?? (ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll);
  const outcome = await approvals.request(req);
  await runtime.audit.append({
    ...base,
    event: 'approval.decision',
    tool: req.tool,
    ...decisionAudit(req, outcome, 'ship', undefined),
  });
  await recordOverride({ audit: runtime.audit, redactor: ctx.redactor }, req, outcome, {
    actor: 'ship',
    task,
    connector: source.provider,
    tool: req.tool,
  });
  if (outcome.decision !== 'approved') {
    ctx.term.err(
      outcome.decision === 'expired'
        ? 'The approval expired. Nothing was pushed.'
        : `Not approved${ctx.prompter || i.hooks.approvals ? '' : ' (no terminal to ask on)'}. Nothing was pushed.`,
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
  i.hooks.onResult?.(url ? { prUrl: url } : {});
  await audit(runtime.audit, task, `opened ${url ?? head}`);
  return 0;
}
