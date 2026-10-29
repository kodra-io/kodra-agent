import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectStack, helmChart } from '@kodra-agent/templates';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import { startRuntime } from './runtime.ts';
import { sandboxDestroy, sandboxSweep } from './sandbox/sandbox.ts';
import { spawnExec } from './ship/exec.ts';
import { repoFiles } from './ship/workspace.ts';
import {
  configYaml,
  posixPath,
  scriptedPrompter,
  tempDir,
  testContext,
  writeConfig,
} from './test-helpers.ts';

/**
 * M4 done criteria against a real kind cluster and the real Kubernetes MCP server:
 * chat explains a crashlooping pod with read-only tools, a write asks for approval in the
 * CLI, and a blocked action lands in the audit log. Run with `pnpm test:kind`, which
 * creates the cluster and sets KODRA_KIND_KUBECONFIG. The model is scripted, so no API key
 * is needed; scripts/demo-crashloop.ts runs the same scenario with a real model.
 */
// The agent's own service account (scripts/kind-test.ts binds it with the bundle's rbac.yaml),
// and the cluster admin, used only to check what happened.
const kubeconfig = process.env['KODRA_KIND_KUBECONFIG'];
const adminKubeconfig = process.env['KODRA_KIND_ADMIN_KUBECONFIG'] ?? kubeconfig;
const NS = 'payments';
// B2: the sandbox namespace and the test image scripts/kind-test.ts loaded into kind.
const SANDBOX = process.env['KODRA_KIND_SANDBOX'];
const SANDBOX_IMAGE = process.env['KODRA_KIND_SANDBOX_IMAGE'];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const toolCall = (toolName: string, input: Record<string, unknown>) => ({
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: `c-${String(Date.now())}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'end_turn' },
  usage,
  warnings: [],
});

/** The text of the latest tool result in a prompt. */
interface CallOptions {
  prompt: { role: string; content: unknown }[];
}

function lastToolOutput(options: CallOptions): string {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== 'tool') continue;
    return JSON.stringify(message.content);
  }
  return '';
}

/** A model that investigates like a careful engineer would, step by step. */
function scriptedModel() {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const lastUser = [...options.prompt].reverse().find((m) => m.role === 'user');
      const ask = JSON.stringify(lastUser?.content ?? '');
      const toolTurns = options.prompt.filter((m) => m.role === 'tool').length;
      const sinceUser = options.prompt.length - 1 - options.prompt.lastIndexOf(lastUser as never);

      if (ask.includes('why')) {
        if (sinceUser === 0)
          return Promise.resolve(toolCall('kubernetes__pods_list_in_namespace', { namespace: NS }));
        const pod = /crashloop-[a-z0-9]+-[a-z0-9]+/.exec(JSON.stringify(options.prompt))?.[0];
        const errorLine = /Error: [^"\\]+/.exec(lastToolOutput(options))?.[0];
        // Current logs first; if the container just restarted, the previous one's logs.
        if (sinceUser === 2) {
          return Promise.resolve(
            pod
              ? toolCall('kubernetes__pods_log', { namespace: NS, name: pod })
              : say('I could not find the crashlooping pod.'),
          );
        }
        if (sinceUser === 4 && !errorLine && pod) {
          return Promise.resolve(
            toolCall('kubernetes__pods_log', { namespace: NS, name: pod, previous: true }),
          );
        }
        return Promise.resolve(
          say(`The pod keeps crashing. Its last log line: ${errorLine ?? 'no error line found'}`),
        );
      }
      if (ask.includes('scale')) {
        if (sinceUser === 0) {
          return Promise.resolve(
            toolCall('kubernetes__resources_scale', {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              namespace: NS,
              name: 'crashloop',
              scale: 2,
              kodra_reason: 'test: scale to two replicas',
            }),
          );
        }
        return Promise.resolve(say('Done.'));
      }
      if (ask.includes('system')) {
        if (sinceUser === 0)
          return Promise.resolve(
            toolCall('kubernetes__pods_list_in_namespace', { namespace: 'kube-system' }),
          );
        return Promise.resolve(say('That namespace is off limits.'));
      }
      return Promise.resolve(say(`unexpected (${String(toolTurns)})`));
    },
  });
}

describe.skipIf(!kubeconfig)('kind: crashlooping pod', () => {
  it(
    'explains the crash, asks before scaling, and audits a blocked read',
    { timeout: 180_000 },
    async () => {
      const dir = await tempDir();
      const auditPath = join(dir, 'audit', 'audit.jsonl');
      const path = await writeConfig(
        configYaml({
          auditPath: posixPath(auditPath),
          model:
            '    provider: anthropic\n    name: scripted\n    apiKey: ${env:ANTHROPIC_API_KEY}',
          connectors: [
            '    kubernetes:',
            '      enabled: true',
            '      access: read-write-approved',
            `      config: {namespaces: [${NS}]}`,
            `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfig ?? '')}}'}`,
          ].join('\n'),
        }),
        dir,
      );
      const model = scriptedModel();
      const run = async (message: string, prompter = scriptedPrompter([])) => {
        const t = testContext({
          env: { ANTHROPIC_API_KEY: 'not-used-by-the-scripted-model' },
          modelFactory: () => model,
          prompter,
        });
        const code = await main(['chat', '--config', path, '--message', message], t.ctx);
        return { code, out: t.output() };
      };

      // 0. F9: the agent's role can scale and nothing else. It cannot patch or update the
      // Deployment itself (its pod template), and it passes the credential reach check.
      const can = (...args: string[]) =>
        spawnSync(
          'kubectl',
          ['--kubeconfig', kubeconfig ?? '', '-n', NS, 'auth', 'can-i', ...args],
          {
            encoding: 'utf8',
          },
        ).stdout.trim();
      expect(can('update', 'deployments', '--subresource=scale')).toBe('yes');
      expect(can('get', 'deployments', '--subresource=scale')).toBe('yes');
      expect(can('patch', 'deployments')).toBe('no');
      expect(can('update', 'deployments')).toBe('no');
      expect(can('patch', 'deployments', '--subresource=scale')).toBe('no');
      expect(can('get', 'secrets')).toBe('no');

      // 1. Read-only investigation against the real cluster.
      const why = await run('why is the crashloop deployment failing?');
      expect(why.code).toBe(0);
      expect(why.out).not.toContain('more access than the agent needs');
      expect(why.out).toContain('[read] kubernetes/pods_list_in_namespace');
      expect(why.out).toContain('[read] kubernetes/pods_log');
      expect(why.out).toContain('Its last log line: Error: cannot connect to database at db:5432');

      // 2. A write asks for approval at the terminal, then runs.
      const approver = scriptedPrompter([true]);
      const scale = await run('scale the crashloop deployment to 2', approver);
      expect(approver.asked).toEqual(['Approve this action?']);
      expect(scale.out).toContain('Approval needed (write): kubernetes / resources_scale');
      expect(scale.out).toContain('Why:       test: scale to two replicas');
      const replicas = execFileSync(
        'kubectl',
        [
          '--kubeconfig',
          adminKubeconfig ?? '',
          '-n',
          NS,
          'get',
          'deployment',
          'crashloop',
          '-o',
          'jsonpath={.spec.replicas}',
        ],
        {
          encoding: 'utf8',
        },
      );
      expect(replicas).toBe('2');

      // 3. A read outside the configured namespaces is blocked and audited.
      const blocked = await run('what runs in kube-system?');
      expect(blocked.out).toContain('[blocked] kubernetes/pods_list_in_namespace');

      const audit = (await readFile(auditPath, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, string>);
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'approval.decision',
          decision: 'approved',
          tool: 'resources_scale',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          decision: 'approved',
          tool: 'resources_scale',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          decision: 'blocked',
          tool: 'pods_list_in_namespace',
        }),
      );
    },
  );
});

const admin = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, KUBECONFIG: adminKubeconfig ?? '', HELM_DRIVER: 'configmap' },
  });

/** A repo like one the agent onboarded: the node sample with a chart for the test image. */
async function sandboxRepo(dir: string, image: string): Promise<{ bare: string; chart: string }> {
  const seed = join(dir, 'seed');
  await cp(new URL('../../../examples/ship/node/', import.meta.url), seed, { recursive: true });
  const detected = detectStack(repoFiles(seed), 'echo');
  if (!detected.ok) throw new Error(detected.reason);
  const files = helmChart(
    { ...detected.detection, name: 'echo', port: 8080, healthPath: null, portEnv: null },
    { image, generatedDockerfile: false },
  );
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  const git = (args: string[], cwd?: string) =>
    spawnExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      ...(cwd ? { cwd } : {}),
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.no-such-config') },
    });
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    ['commit', '-q', '-m', 'init'],
  ]) {
    expect((await git(args, seed)).code).toBe(0);
  }
  const bare = join(dir, 'remote.git');
  expect((await git(['clone', '-q', '--bare', seed, bare])).code).toBe(0);
  return { bare, chart: join(seed, 'charts', 'echo') };
}

describe.skipIf(!kubeconfig || !SANDBOX || !SANDBOX_IMAGE)('kind: sandbox test (B2)', () => {
  it(
    'deploys a test release, checks it, destroys it, and touches nothing it did not make',
    { timeout: 300_000 },
    async () => {
      const sandbox = SANDBOX ?? '';
      const [repository = '', tag = ''] = (SANDBOX_IMAGE ?? '').split(':');
      const dir = await tempDir();
      const { bare, chart } = await sandboxRepo(dir, repository);
      const auditPath = join(dir, 'audit', 'audit.jsonl');
      const path = await writeConfig(
        configYaml({
          auditPath: posixPath(auditPath),
          connectors: [
            '    github:',
            '      enabled: true',
            '      config: {repos: [acme/echo]}',
            "      secrets: {token: '${env:GITHUB_TOKEN}'}",
            '    kubernetes:',
            '      enabled: true',
            '      access: read-write-approved',
            `      config: {namespaces: [${NS}], sandbox: ${sandbox}}`,
            `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfig ?? '')}}'}`,
          ].join('\n'),
        }),
        dir,
      );
      const t = testContext({
        env: { GITHUB_TOKEN: 'not-used-by-a-local-remote' },
        prompter: scriptedPrompter([true]),
        gitRemote: () => bare,
        sandboxStableMs: 5000,
      });

      // 0. The agent's sandbox Role: test releases there, nothing else, never Secrets.
      const can = (ns: string, ...args: string[]) =>
        spawnSync(
          'kubectl',
          ['--kubeconfig', kubeconfig ?? '', '-n', ns, 'auth', 'can-i', ...args],
          { encoding: 'utf8' },
        ).stdout.trim();
      expect(can(sandbox, 'create', 'deployments')).toBe('yes');
      expect(can(sandbox, 'delete', 'configmaps')).toBe('yes');
      expect(can(sandbox, 'get', 'secrets')).toBe('no');
      expect(can(sandbox, 'create', 'secrets')).toBe('no');
      expect(can(NS, 'create', 'deployments')).toBe('no');
      expect(can(NS, 'create', 'configmaps')).toBe('no');
      expect(can('default', 'create', 'deployments')).toBe('no');

      // 1. Deploy, smoke-test, and destroy, after one approval.
      const code = await main(
        ['sandbox', 'deploy', 'acme/echo', '--tag', tag, '--config', path],
        t.ctx,
      );
      const out = t.output();
      expect(code, out).toBe(0);
      expect(out).toContain('passed');
      expect(out).toContain('Destroyed.');
      const left = admin('kubectl', [
        '-n',
        sandbox,
        'get',
        'deployments,services,configmaps',
        '-l',
        'kodra.io/owner=kodra-agent',
        '-o',
        'name',
      ]);
      expect(left.stdout.trim()).toBe('');
      expect(
        admin('helm', [
          'list',
          '-n',
          sandbox,
          '--deployed',
          '--failed',
          '--pending',
          '-q',
        ]).stdout.trim(),
      ).toBe('');

      // 2. Another team's release in the sandbox, even one named like ours, is never removed.
      const other = 'kt-abcdef12';
      const installed = admin('helm', [
        'install',
        other,
        chart,
        '-n',
        sandbox,
        '--set-string',
        `image.repository=${repository}`,
        '--set-string',
        `image.tag=${tag}`,
      ]);
      expect(installed.status, installed.stderr).toBe(0);
      await writeFile(
        join(dirname(auditPath), 'sandbox.json'),
        JSON.stringify([
          {
            id: 'abcdef12',
            release: other,
            namespace: sandbox,
            repo: 'acme/echo',
            branch: 'main',
            sha: 'x',
            image: SANDBOX_IMAGE,
            requestedBy: 'forged',
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: '2026-01-01T00:00:00Z',
          },
        ]),
      );
      const runtime = await startRuntime(path, t.ctx);
      if (!runtime) throw new Error(t.output());
      try {
        expect(await sandboxDestroy(t.ctx, runtime, 'abcdef12', 'test')).toEqual({ ok: true });
        expect(
          (await sandboxSweep(t.ctx, runtime, Date.now() + 3 * 24 * 60 * 60 * 1000)).destroyed,
        ).toEqual([]);
      } finally {
        await runtime.close();
      }
      expect(admin('helm', ['status', other, '-n', sandbox]).status).toBe(0);
      admin('helm', ['uninstall', other, '-n', sandbox]);
    },
  );
});
