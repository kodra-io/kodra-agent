import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_A_SANDBOX } from '@kodra-agent/connectors';
import { resolvePolicy } from '@kodra-agent/schema';
import { analyzeRepo } from '@kodra-agent/templates';
import { parse as parseYaml } from 'yaml';
import { recordOverride } from '../agent.ts';
import {
  cliApprovalChannel,
  decisionAudit,
  newApprovalRequest,
  rulesFor,
  type ApprovalChannel,
} from '../approvals.ts';
import { findSource, postToSlack, settingList } from '../commands/ship.ts';
import { AGENT_NAMESPACE, type Context } from '../context.ts';
import type { ConnectorInput } from '../mcp/host.ts';
import { TOKEN_PATTERNS } from '../redactor.ts';
import { startRuntime, type Runtime } from '../runtime.ts';
import { spawnExec } from '../ship/exec.ts';
import { Git, remoteUrl, repoFiles, writeEmptyFile } from '../ship/workspace.ts';
import { realSandboxCluster, type SandboxCluster } from './cluster.ts';
import { sandboxHelm, type Helm } from './helm.ts';
import { readTests, sandboxStatePath, updateTests, type SandboxTest } from './state.ts';

/**
 * Test in a sandbox, then destroy (B2). One approval deploys a branch's CI image with its own
 * chart as a Helm release in the sandbox namespace, smoke-tests it, reports, and uninstalls
 * it. The agent destroys only what it made: a release must be in sandbox.json and carry its
 * labels, so another team's release in the same namespace is never touched.
 */

export const OWNER_LABEL = 'kodra.io/owner';
export const AGENT_LABEL = 'kodra.io/agent';
export const TEST_LABEL = 'kodra.io/test';
const OWNER = 'kodra-agent';
/** The longest a test may be kept; the sweep removes anything of ours older than this. */
export const MAX_KEEP_MS = 24 * 60 * 60 * 1000;
/** How long a deploy may take before it counts as failed. */
const INSTALL_TIMEOUT = '5m';
/** A test that was never destroyed (the agent stopped mid-test) is swept after this. */
const RUNNING_GRACE_MS = 15 * 60_000;
const RELEASE = /^kt-[0-9a-f]{8}$/;
const TAG = /^\w[\w.-]{0,127}$/;
const LIST_STATES = ['--deployed', '--failed', '--pending', '--uninstalling'];

export interface SandboxSetup {
  namespace: string;
  pullSecret: string | null;
  input: ConnectorInput;
}

/** The sandbox settings, or why there is no sandbox to test in. */
export function sandboxSetup(
  runtime: Runtime,
): { ok: true; setup: SandboxSetup } | { ok: false; reason: string } {
  const input = runtime.inputs.find((i) => i.component.id === 'kubernetes');
  if (!input) return { ok: false, reason: 'Testing in a sandbox needs the Kubernetes connector.' };
  const settings = input.component.settings;
  const namespace = typeof settings['sandbox'] === 'string' ? settings['sandbox'].trim() : '';
  if (!namespace) {
    return {
      ok: false,
      reason:
        'No sandbox namespace is set. Set "sandbox" on the Kubernetes connector and give the agent its Role (the kubeconfig steps show how).',
    };
  }
  if (input.access !== 'read-write-approved') {
    return {
      ok: false,
      reason: 'Testing in a sandbox needs the Kubernetes connector at read-write-approved access.',
    };
  }
  const own = runtime.env['KODRA_AGENT_SELF_NAMESPACE'] ?? AGENT_NAMESPACE;
  if (
    NOT_A_SANDBOX.includes(namespace) ||
    namespace === own ||
    settingList(settings, 'namespaces').includes(namespace)
  ) {
    return {
      ok: false,
      reason: `${namespace} cannot be the sandbox: it must be a namespace of its own, not one the agent watches, its own, default, or kube-*.`,
    };
  }
  const pull = settings['sandboxPullSecret'];
  return {
    ok: true,
    setup: { namespace, pullSecret: typeof pull === 'string' && pull ? pull : null, input },
  };
}

/** What a sandbox operation works with: Helm and the cluster, both with the connector's credentials. */
interface Ops {
  ctx: Context;
  runtime: Runtime;
  setup: SandboxSetup;
  helm: Helm;
  cluster: SandboxCluster;
  statePath: string;
  /** This agent's name, so two agents sharing a sandbox never touch each other's tests. */
  agent: string;
}

async function openOps(ctx: Context, runtime: Runtime, setup: SandboxSetup): Promise<Ops> {
  const secrets = setup.input.secrets;
  const credentials = {
    kubeconfig: secrets['kubeconfig'],
    awsAccessKeyId: secrets['awsAccessKeyId'],
    awsSecretAccessKey: secrets['awsSecretAccessKey'],
  };
  const helm = await sandboxHelm({
    exec: ctx.exec ?? spawnExec,
    redactor: ctx.redactor,
    credentials,
    networkEnv: runtime.networkEnv,
  });
  const id = credentials.awsAccessKeyId;
  const key = credentials.awsSecretAccessKey;
  const cluster = (ctx.sandboxCluster ?? realSandboxCluster)(
    credentials.kubeconfig,
    id && key ? { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: key } : undefined,
  );
  return {
    ctx,
    runtime,
    setup,
    helm,
    cluster,
    statePath: sandboxStatePath(runtime.config.spec.audit.path),
    agent: runtime.config.metadata.name,
  };
}

const selector = (ops: Ops, id?: string) =>
  [
    `${OWNER_LABEL}=${OWNER}`,
    `${AGENT_LABEL}=${ops.agent}`,
    ...(id ? [`${TEST_LABEL}=${id}`] : []),
  ].join(',');

const placeholders = (release: string) => `${release}-placeholders`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Our releases in the sandbox, found by our labels (Helm's JSON has no labels itself). */
async function ownReleases(
  ops: Ops,
  id?: string,
): Promise<{ name: string; updated: number }[] | { error: string }> {
  const r = await ops.helm.run(
    [
      'list',
      '-n',
      ops.setup.namespace,
      // Every state a test can be left in (Helm 4 has no --all).
      ...LIST_STATES,
      '-l',
      selector(ops, id),
      '-o',
      'json',
    ],
    60_000,
  );
  if (r.code !== 0) return { error: r.stderr.trim() || 'helm list failed' };
  try {
    const list = JSON.parse(r.stdout || '[]') as { name?: unknown; updated?: unknown }[];
    return list
      .filter((x): x is { name: string; updated?: unknown } => typeof x.name === 'string')
      .map((x) => ({ name: x.name, updated: helmTime(x.updated) }));
  } catch {
    return { error: 'helm list printed something that is not JSON' };
  }
}

/** Helm prints times like "2026-10-29 10:04:05.123456 +0000 UTC"; NaN when it does not. */
export function helmTime(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)? ([+-]\d\d)(\d\d)/.exec(value);
  if (!m) return Date.parse(value);
  return Date.parse(
    `${m[1] ?? ''}T${m[2] ?? ''}${(m[3] ?? '').slice(0, 4)}${m[4] ?? ''}:${m[5] ?? ''}`,
  );
}

async function auditTool(
  ops: Ops,
  task: string,
  tool: string,
  decision: 'approved' | 'allowed',
  detail: string,
): Promise<void> {
  await ops.runtime.audit.append({
    event: 'tool.call',
    actor: 'sandbox',
    task,
    connector: 'kubernetes',
    tool,
    risk: 'write',
    decision,
    detail: ops.ctx.redactor.redact(detail).slice(0, 4000),
  });
}

/**
 * Uninstalls one of our tests and its placeholders. The release must carry our labels, so
 * a name alone is never enough. Cleanup is never refused by the write limits: it only ever
 * removes what an approved test made.
 */
async function destroyTest(
  ops: Ops,
  test: Pick<SandboxTest, 'id' | 'release'>,
  why: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const task = `sandbox-${test.id}`;
  const ns = ops.setup.namespace;
  const owned = await ownReleases(ops, test.id);
  if ('error' in owned) return { ok: false, reason: owned.error };
  if (owned.some((r) => r.name === test.release)) {
    const r = await ops.helm.run(
      ['uninstall', test.release, '-n', ns, '--wait', '--timeout', '2m'],
      3 * 60_000,
    );
    await auditTool(
      ops,
      task,
      'helm uninstall',
      'allowed',
      `${r.code === 0 ? 'ok' : 'error'}; ${test.release} in ${ns} (${why})`,
    );
    if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || 'helm uninstall failed' };
  }
  try {
    // Only our placeholders: Helm's own record ConfigMaps carry the same labels.
    const ours = await ops.cluster.configMaps(ns, selector(ops, test.id));
    for (const cm of ours.filter((c) => c.name === placeholders(test.release))) {
      await ops.cluster.deleteConfigMap(ns, cm.name);
    }
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  await updateTests(ops.statePath, (tests) => tests.filter((t) => t.id !== test.id));
  return { ok: true };
}

export interface SandboxOptions {
  configPath: string;
  /** owner/repo or group/project, as configured. */
  repo: string;
  /** Default: the repo's default branch. */
  branch?: string | undefined;
  /** Default: pr-<sha>, or <sha> on the default branch, the tags the generated CI pushes. */
  tag?: string | undefined;
  /** How long to keep it after the test; 0 destroys it right away. */
  keepMs: number;
}

export interface SandboxHooks {
  runtime?: Runtime;
  approvals?: ApprovalChannel;
  requestedBy?: string;
  post?: (text: string) => Promise<void>;
  onResult?: (result: SandboxResult) => void;
}

export interface SandboxResult {
  id: string;
  passed: boolean;
  report: string;
  /** When it is destroyed, if it was kept. */
  keptUntil?: string;
}

/** Without a terminal there is nobody to approve, so the deploy is refused. */
const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'no-terminal' }),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deploys a branch to the sandbox, smoke-tests it, reports, and destroys it (B2). */
export async function sandboxDeploy(
  opts: SandboxOptions,
  ctx: Context,
  hooks: SandboxHooks = {},
): Promise<number> {
  if (opts.keepMs < 0 || opts.keepMs > MAX_KEEP_MS) {
    ctx.term.err('A test can be kept for at most 24 hours.');
    return 2;
  }
  if (opts.tag !== undefined && !TAG.test(opts.tag)) {
    ctx.term.err(`'${opts.tag}' is not an image tag.`);
    return 2;
  }
  const runtime = hooks.runtime ?? (await startRuntime(opts.configPath, ctx));
  if (!runtime) return 1;
  const work = await mkdtemp(join(tmpdir(), 'kodra-sandbox-repo-'));
  let ops: Ops | null = null;
  try {
    const checked = sandboxSetup(runtime);
    if (!checked.ok) {
      ctx.term.err(checked.reason);
      return 1;
    }
    const source = findSource(runtime, opts.repo);
    if (!source) {
      ctx.term.err(
        `${opts.repo} is not in the configured GitHub repos or GitLab projects. Add it to kodra-agent.yaml first.`,
      );
      return 1;
    }
    const paused = runtime.control.reason();
    if (paused) {
      ctx.term.err(`${paused} Nothing was deployed.`);
      return 1;
    }
    ops = await openOps(ctx, runtime, checked.setup);
    const ns = checked.setup.namespace;

    // 1. The branch's commit and chart.
    const baseExec = ctx.exec ?? spawnExec;
    const git = Git.create({
      exec: (command, args, o = {}) =>
        baseExec(command, args, { ...o, env: { ...runtime.networkEnv, ...o.env } }),
      redactor: ctx.redactor,
      emptyConfig: await writeEmptyFile(join(work, 'gitconfig')),
      provider: source.provider,
      token: source.input.secrets['token'] ?? '',
    });
    const url =
      ctx.gitRemote?.(source.provider, source.repo) ??
      remoteUrl(source.provider, source.repo, source.gitlabUrl);
    const repoDir = join(work, 'repo');
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
    const sha = (await git.run(['rev-parse', 'HEAD'], repoDir)).stdout.trim();
    const branch =
      opts.branch ?? (await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).stdout.trim();
    const head = await git.run(['ls-remote', '--symref', 'origin', 'HEAD'], repoDir);
    const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.stdout)?.[1] ?? null;
    const chart = await findChart(repoDir, source.repo);
    if ('error' in chart) {
      ctx.term.err(chart.error);
      return 1;
    }
    const tag = opts.tag ?? (branch === defaultBranch ? sha : `pr-${sha}`);
    const image = `${chart.repository}:${tag}`;
    const analysis = analyzeRepo(repoFiles(repoDir), source.repo, TOKEN_PATTERNS);
    const secretNames = analysis.config.filter((v) => v.secret).map((v) => v.name);
    const d = analysis.detection.ok ? analysis.detection.detection : null;
    const path = d?.probes?.readiness ?? d?.healthPath ?? '/';

    // 2. One approval for the whole test: deploy, check, destroy.
    const id = randomBytes(4).toString('hex');
    const release = `kt-${id}`;
    const task = `sandbox-${id}`;
    await runtime.audit.append({
      event: 'task.start',
      actor: 'sandbox',
      task,
      detail: `${source.repo} ${branch} @ ${sha.slice(0, 12)}`,
    });
    const rules = rulesFor(resolvePolicy(runtime.config.spec), { namespaces: [ns], repos: [] });
    if (!rules.ok) {
      ctx.term.err(`Blocked by policy: ${rules.reason}. Nothing was deployed.`);
      return 1;
    }
    const approvals =
      hooks.approvals ?? (ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll);
    const slot = runtime.deps(approvals).writes?.begin(rules.rules.environment) ?? {
      release: () => undefined,
      done: () => undefined,
    };
    if ('refused' in slot) {
      ctx.term.err(`Not now: ${slot.refused}. Nothing was deployed.`);
      return 1;
    }
    try {
      const keep = opts.keepMs > 0 ? `, kept for ${duration(opts.keepMs)}` : ', then destroyed';
      const summary = ctx.redactor.redact(
        JSON.stringify({
          namespace: ns,
          release,
          image,
          chart: chart.dir,
          keep: duration(opts.keepMs),
        }),
      );
      const req = newApprovalRequest(
        {
          connector: 'kubernetes',
          tool: 'sandbox test',
          risk: 'write',
          args: summary,
          reason: `Test ${source.repo} (${branch}) in the sandbox: install ${image} with its chart as ${release} in ${ns}, smoke-test it${keep}. Nothing outside ${ns} changes.`,
          requestedBy: hooks.requestedBy ?? 'sandbox',
        },
        rules.rules,
      );
      const base = { actor: 'sandbox', task, connector: 'kubernetes', risk: 'write' } as const;
      await runtime.audit.append({
        ...base,
        event: 'approval.request',
        tool: req.tool,
        detail: `${req.id}; args ${summary}`,
      });
      const outcome = await approvals.request(req);
      await runtime.audit.append({
        ...base,
        event: 'approval.decision',
        tool: req.tool,
        ...decisionAudit(req, outcome, 'sandbox', undefined),
      });
      await recordOverride({ audit: runtime.audit, redactor: ctx.redactor }, req, outcome, {
        actor: 'sandbox',
        task,
        connector: 'kubernetes',
        tool: req.tool,
      });
      if (outcome.decision !== 'approved') {
        ctx.term.err(
          outcome.decision === 'expired'
            ? 'The approval expired. Nothing was deployed.'
            : 'Not approved. Nothing was deployed.',
        );
        return 1;
      }

      // 3. Deploy. The test is recorded first, so a crash mid-deploy is still swept.
      const now = Date.now();
      const test: SandboxTest = {
        id,
        release,
        namespace: ns,
        repo: source.repo,
        branch,
        sha,
        image,
        requestedBy: hooks.requestedBy ?? 'sandbox',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Math.max(opts.keepMs, 0) + RUNNING_GRACE_MS).toISOString(),
      };
      await updateTests(ops.statePath, (tests) => [...tests, test]);
      const labels = { [OWNER_LABEL]: OWNER, [AGENT_LABEL]: ops.agent, [TEST_LABEL]: id };
      ctx.term.out(`Deploying ${image} to ${ns} as ${release}...`);
      const started = Date.now();
      let deployed: { ok: true } | { ok: false; reason: string };
      try {
        await ops.cluster.createConfigMap(
          ns,
          placeholders(release),
          labels,
          Object.fromEntries(secretNames.map((n) => [n, 'sandbox-placeholder'])),
        );
        deployed = await install(ops, {
          release,
          chartDir: join(repoDir, chart.dir),
          repository: chart.repository,
          tag,
          labels,
          envSecret: `${chart.name}-sandbox-env`,
        });
      } catch (error) {
        deployed = { ok: false, reason: message(error) };
      }
      slot.done();
      await auditTool(
        ops,
        task,
        'helm install',
        'approved',
        `${deployed.ok ? 'ok' : 'error'}; ${release} in ${ns}, image ${image}`,
      );

      // 4. Smoke test.
      const instance = `app.kubernetes.io/instance=${release}`;
      const lines: string[] = [];
      let passed = deployed.ok;
      if (deployed.ok) {
        lines.push(`• Deployed in ${String(Math.round((Date.now() - started) / 1000))}s`);
        const check = await smoke(ops, instance, path, ctx.sandboxStableMs ?? 20_000);
        passed = check.ok;
        lines.push(...check.lines);
      } else {
        lines.push(`• The deploy failed: ${deployed.reason.split('\n').slice(-3).join(' ')}`);
        const hint = await whyNotRunning(ops, instance, image);
        if (hint) lines.push(`• ${hint}`);
      }

      // 5. Report, then destroy unless kept.
      let end: string;
      let keptUntil: string | undefined;
      if (opts.keepMs > 0) {
        keptUntil = new Date(Date.now() + opts.keepMs).toISOString();
        await updateTests(ops.statePath, (tests) =>
          tests.map((t) =>
            t.id === id
              ? { ...t, expiresAt: keptUntil ?? t.expiresAt, result: passed ? 'passed' : 'failed' }
              : t,
          ),
        );
        end = `Kept until ${keptUntil.slice(11, 16)} UTC. Destroy it sooner from the console or with \`kodra-agent sandbox destroy ${id}\`.`;
      } else {
        const gone = await destroyTest(ops, test, 'test finished');
        end = gone.ok
          ? 'Destroyed.'
          : `Could not destroy it yet (${gone.reason}); the next sweep tries again.`;
      }
      const report = [
        `*Sandbox test ${release}* of ${source.repo} (${branch} @ ${sha.slice(0, 7)}): ${passed ? 'passed' : 'failed'}`,
        `• Image: ${image}`,
        ...lines,
        end,
      ].join('\n');
      ctx.term.out(report);
      await runtime.audit.append({
        event: 'result',
        actor: 'sandbox',
        task,
        detail: `${passed ? 'passed' : 'failed'}; ${keptUntil ? `kept until ${keptUntil}` : end}`,
      });
      hooks.onResult?.({ id, passed, report, ...(keptUntil ? { keptUntil } : {}) });
      if (hooks.post) await hooks.post(ctx.redactor.redact(report)).catch(() => undefined);
      else await postToSlack(ctx, runtime, report, 'the result');
      return passed ? 0 : 1;
    } finally {
      slot.release();
    }
  } finally {
    await ops?.helm.close();
    await rm(work, { recursive: true, force: true });
    if (!hooks.runtime) await runtime.close();
  }
}

/** The chart CI builds for: charts/<repo name>, or the only chart there is. */
async function findChart(
  repoDir: string,
  repo: string,
): Promise<{ dir: string; name: string; repository: string } | { error: string }> {
  const names = await readdir(join(repoDir, 'charts'), { withFileTypes: true }).catch(() => []);
  const charts: string[] = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const yaml = await readFile(join(repoDir, 'charts', entry.name, 'Chart.yaml'), 'utf8').catch(
      () => null,
    );
    if (yaml !== null) charts.push(entry.name);
  }
  const own = repo.split('/').at(-1) ?? '';
  const name = charts.includes(own) ? own : charts.length === 1 ? charts[0] : undefined;
  if (!name) {
    return {
      error:
        charts.length === 0
          ? 'This branch has no Helm chart under charts/. Onboard the repo first: its pull request adds one.'
          : `This branch has more than one chart under charts/ (${charts.join(', ')}) and none is named after the repo.`,
    };
  }
  let repository: unknown;
  try {
    const values = parseYaml(
      await readFile(join(repoDir, 'charts', name, 'values.yaml'), 'utf8'),
    ) as { image?: { repository?: unknown } } | null;
    repository = values?.image?.repository;
  } catch {
    repository = undefined;
  }
  if (typeof repository !== 'string' || !repository) {
    return { error: `charts/${name}/values.yaml has no image.repository.` };
  }
  return { dir: `charts/${name}`, name, repository };
}

async function install(
  ops: Ops,
  o: {
    release: string;
    chartDir: string;
    repository: string;
    tag: string;
    labels: Record<string, string>;
    envSecret: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const envFrom = [
    { configMapRef: { name: placeholders(o.release) } },
    // Real test values, if the team made the Secret. The agent never reads it.
    { secretRef: { name: o.envSecret, optional: true } },
  ];
  const pull = ops.setup.pullSecret;
  const r = await ops.helm.run(
    [
      'install',
      o.release,
      o.chartDir,
      '-n',
      ops.setup.namespace,
      '--wait',
      '--timeout',
      INSTALL_TIMEOUT,
      '--labels',
      Object.entries(o.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(','),
      '--set-string',
      `image.repository=${o.repository}`,
      '--set-string',
      `image.tag=${o.tag}`,
      '--set',
      'replicaCount=1',
      '--set-json',
      `extraEnvFrom=${JSON.stringify(envFrom)}`,
      ...(pull ? ['--set-json', `imagePullSecrets=${JSON.stringify([{ name: pull }])}`] : []),
    ],
    6 * 60_000,
  );
  return r.code === 0
    ? { ok: true }
    : { ok: false, reason: r.stderr.trim() || 'helm install failed' };
}

/** A plain reason the pods are not running, with what to do about it. */
async function whyNotRunning(ops: Ops, instance: string, image: string): Promise<string | null> {
  const pods = await ops.cluster.pods(ops.setup.namespace, instance).catch(() => []);
  const waiting = pods.map((p) => p.waiting).find(Boolean);
  if (waiting === 'ImagePullBackOff' || waiting === 'ErrImagePull') {
    return `The cluster could not pull ${image}. Check that CI pushed this tag; for a private registry, set sandboxPullSecret on the Kubernetes connector.`;
  }
  if (waiting === 'CrashLoopBackOff') {
    return 'The app starts and then exits. Its logs say why; it may need settings or a test Secret (see docs/sandbox.md).';
  }
  if (waiting === 'CreateContainerConfigError') {
    return 'Kubernetes could not set up the container, often a missing ConfigMap or Secret it refers to.';
  }
  return waiting ? `The pods are waiting: ${waiting}.` : null;
}

/** The service answers below 500, and the pods stay ready without restarting. */
async function smoke(
  ops: Ops,
  instance: string,
  path: string,
  stableMs: number,
): Promise<{ ok: boolean; lines: string[] }> {
  const ns = ops.setup.namespace;
  const lines: string[] = [];
  let ok = true;
  try {
    const service = (await ops.cluster.services(ns, instance))[0];
    if (service) {
      const status = await ops.cluster.get(ns, service.name, service.port, path);
      const answered = status > 0 && status < 500;
      ok &&= answered;
      lines.push(
        `• GET ${path}: ${status > 0 ? String(status) : 'no answer'}${answered ? '' : ' (failed)'}`,
      );
    } else {
      lines.push('• No service to call; checked the pods only');
    }
    const before = await ops.cluster.pods(ns, instance);
    await sleep(stableMs);
    const after = await ops.cluster.pods(ns, instance);
    const restarts = (pods: typeof after) => pods.reduce((n, p) => n + p.restarts, 0);
    const added = restarts(after) - restarts(before);
    const ready = after.length > 0 && after.every((p) => p.ready);
    ok &&= added === 0 && ready;
    lines.push(
      added === 0 && ready
        ? `• Ready, with no restarts in ${String(Math.round(stableMs / 1000))} seconds`
        : `• ${ready ? '' : 'Not ready; '}${String(added)} restarts in ${String(Math.round(stableMs / 1000))} seconds (failed)`,
    );
  } catch (error) {
    ok = false;
    lines.push(
      `• The check could not reach the cluster: ${ops.ctx.redactor.redact(message(error))}`,
    );
  }
  return { ok, lines };
}

const duration = (ms: number) => {
  if (ms === 0) return 'none';
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 ? `${String(minutes / 60)}h` : `${String(minutes)}m`;
};

/** Parses --keep: 0, 30m, 2h (24h at most). */
export function parseKeep(value: string): number | null {
  const m = /^(\d+)([mh]?)$/.exec(value.trim());
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000);
  return ms <= MAX_KEEP_MS ? ms : null;
}

/** With the sandbox's Helm and cluster open, for the commands below. */
async function withOps<T>(
  ctx: Context,
  runtime: Runtime,
  run: (ops: Ops) => Promise<T>,
): Promise<T | { error: string }> {
  const checked = sandboxSetup(runtime);
  if (!checked.ok) return { error: checked.reason };
  const ops = await openOps(ctx, runtime, checked.setup);
  try {
    return await run(ops);
  } finally {
    await ops.helm.close();
  }
}

/** The tests that are still up. */
export async function sandboxList(runtime: Runtime): Promise<SandboxTest[]> {
  return readTests(sandboxStatePath(runtime.config.spec.audit.path));
}

/** Destroys one of our tests by id, as a person asked. */
export async function sandboxDestroy(
  ctx: Context,
  runtime: Runtime,
  id: string,
  by: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const test = (await sandboxList(runtime)).find((t) => t.id === id || t.release === id);
  if (!test)
    return {
      ok: false,
      reason: `No sandbox test ${id}. Only the agent's own tests can be destroyed.`,
    };
  const done = await withOps(ctx, runtime, (ops) => destroyTest(ops, test, `destroyed by ${by}`));
  return 'error' in done ? { ok: false, reason: done.error } : done;
}

/**
 * Removes what is past its time: tests whose keep ran out, and anything of ours the list
 * lost (the agent stopped mid-test) once it is older than the longest a test may live.
 */
export async function sandboxSweep(
  ctx: Context,
  runtime: Runtime,
  now: number = Date.now(),
): Promise<{ destroyed: string[]; problems: string[] }> {
  const destroyed: string[] = [];
  const problems: string[] = [];
  // No sandbox, nothing to sweep.
  if (!sandboxSetup(runtime).ok) return { destroyed, problems };
  const result = await withOps(ctx, runtime, async (ops) => {
    const tests = await readTests(ops.statePath);
    for (const t of tests.filter((x) => Date.parse(x.expiresAt) <= now)) {
      const gone = await destroyTest(ops, t, 'its time ran out');
      if (gone.ok) destroyed.push(t.release);
      else problems.push(`${t.release}: ${gone.reason}`);
    }
    const known = new Set(tests.map((t) => t.release));
    const releases = await ownReleases(ops);
    if ('error' in releases) {
      problems.push(releases.error);
      return;
    }
    const old = (t: number) => !Number.isNaN(t) && now - t > MAX_KEEP_MS;
    for (const r of releases.filter(
      (x) => RELEASE.test(x.name) && !known.has(x.name) && old(x.updated),
    )) {
      const gone = await destroyTest(ops, { id: r.name.slice(3), release: r.name }, 'left over');
      if (gone.ok) destroyed.push(r.name);
      else problems.push(`${r.name}: ${gone.reason}`);
    }
    // Placeholders whose deploy never got as far as a release.
    const cms = await ops.cluster.configMaps(ops.setup.namespace, selector(ops)).catch(() => []);
    for (const cm of cms) {
      const release = cm.name.replace(/-placeholders$/, '');
      if (cm.name === release || !RELEASE.test(release) || known.has(release)) continue;
      if (!old(Date.parse(cm.created))) continue;
      await ops.cluster.deleteConfigMap(ops.setup.namespace, cm.name).catch((error: unknown) => {
        problems.push(`${cm.name}: ${message(error)}`);
      });
    }
  });
  if (result && typeof result === 'object' && 'error' in result) problems.push(result.error);
  if (destroyed.length > 0) {
    await runtime.audit.append({
      event: 'result',
      actor: 'sandbox',
      task: `sandbox-sweep-${randomUUID().slice(0, 8)}`,
      detail: `swept ${destroyed.join(', ')}`,
    });
  }
  return { destroyed, problems };
}
