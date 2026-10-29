import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { startRuntime } from '../runtime.ts';
import { spawnExec, type Exec, type ExecOptions } from '../ship/exec.ts';
import { fakeLauncher } from '../test-fixtures/fake-connector.ts';
import {
  configYaml,
  posixPath,
  scriptedPrompter,
  tempDir,
  testContext,
  writeConfig,
} from '../test-helpers.ts';
import type { SandboxCluster, SandboxPod } from './cluster.ts';
import { readTests } from './state.ts';
import {
  helmTime,
  MAX_KEEP_MS,
  parseKeep,
  sandboxDestroy,
  sandboxList,
  sandboxSweep,
} from './sandbox.ts';

const SAMPLES = new URL('../../../../examples/ship/', import.meta.url);
const KUBECONFIG = 'apiVersion: v1\nkind: Config\n# sandbox-kubeconfig-canary-6f1e\n';
const AWS_SECRET = 'awsSandboxCanarySecret0123456789abcdefXYZ'; // gitleaks:allow

const git = (args: string[], cwd?: string) =>
  spawnExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    ...(cwd ? { cwd } : {}),
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd ?? '.', '.no-such-config') },
  });

const CHART = {
  'charts/node-api/Chart.yaml':
    'apiVersion: v2\nname: node-api\nversion: 0.1.0\nappVersion: "0.1.0"\n',
  'charts/node-api/values.yaml': 'image:\n  repository: ghcr.io/acme/node-api\n  tag: ""\n',
  'config.js': 'module.exports = { password: process.env.DATABASE_PASSWORD };\n',
};

/** A bare repo standing in for GitHub: the node sample with a chart, on main and a feature branch. */
async function bareRemote(dir: string, files: Record<string, string> = CHART): Promise<string> {
  const seed = join(dir, 'seed');
  const bare = join(dir, 'remote.git');
  await cp(new URL('node/', SAMPLES), seed, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    ['commit', '-q', '-m', 'init'],
    ['branch', 'feature/x'],
  ]) {
    expect((await git(args, seed)).code).toBe(0);
  }
  expect((await git(['clone', '-q', '--bare', seed, bare])).code).toBe(0);
  return bare;
}

interface Release {
  name: string;
  labels: Record<string, string>;
  updated: string;
}

/** Helm, faked: releases kept in memory, `list -l` filtered by labels as the real one is. */
function fakeHelm(opts: { installFails?: string; releases?: Release[] } = {}) {
  const calls: { args: readonly string[]; opts: ExecOptions | undefined }[] = [];
  const releases: Release[] = [...(opts.releases ?? [])];
  const exec: Exec = async (command, args, o) => {
    if (command === 'git') return spawnExec(command, args, o);
    calls.push({ args, opts: o });
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? '';
    switch (args[0]) {
      case 'list': {
        const wanted = flag('-l')
          .split(',')
          .map((kv) => kv.split('='));
        const match = releases.filter((r) => wanted.every(([k = '', v]) => r.labels[k] === v));
        return ok(JSON.stringify(match.map((r) => ({ name: r.name, updated: r.updated }))));
      }
      case 'install': {
        const labels: Record<string, string> = Object.fromEntries(
          flag('--labels')
            .split(',')
            .map((kv) => kv.split('=') as [string, string]),
        );
        releases.push({ name: args[1] ?? '', labels, updated: '2026-10-29 10:00:00.1 +0000 UTC' });
        return opts.installFails
          ? { code: 1, stdout: '', stderr: opts.installFails }
          : ok('STATUS: deployed');
      }
      case 'uninstall': {
        const i = releases.findIndex((r) => r.name === args[1]);
        if (i < 0) return { code: 1, stdout: '', stderr: 'release: not found' };
        releases.splice(i, 1);
        return ok('uninstalled');
      }
      default:
        return ok();
    }
  };
  return Object.assign(exec, { calls, releases });
}

function fakeCluster(o: { status?: number; pods?: SandboxPod[] } = {}) {
  const configMaps = new Map<
    string,
    { labels: Record<string, string>; data: Record<string, string>; created: string }
  >();
  const gets: string[] = [];
  const credentials: (Readonly<Record<string, string>> | undefined)[] = [];
  const pods = o.pods ?? [{ name: 'p', ready: true, restarts: 0, waiting: null }];
  const factory = (
    _kubeconfig?: string,
    execEnv?: Readonly<Record<string, string>>,
  ): SandboxCluster => {
    credentials.push(execEnv);
    return {
      createConfigMap: (_ns, name, labels, data) => {
        configMaps.set(name, { labels, data, created: new Date().toISOString() });
        return Promise.resolve();
      },
      configMaps: (_ns, selector) => {
        const wanted = selector.split(',').map((kv) => kv.split('='));
        return Promise.resolve(
          [...configMaps.entries()]
            .filter(([, cm]) => wanted.every(([k = '', v]) => cm.labels[k] === v))
            .map(([name, cm]) => ({ name, labels: cm.labels, created: cm.created })),
        );
      },
      deleteConfigMap: (_ns, name) => {
        configMaps.delete(name);
        return Promise.resolve();
      },
      pods: () => Promise.resolve(pods),
      services: (_ns, selector) =>
        Promise.resolve([{ name: `${selector.split('=')[1] ?? ''}-node-api`, port: 'http' }]),
      get: (_ns, service, port, path) => {
        gets.push(`${service}:${port}${path}`);
        return Promise.resolve(o.status ?? 200);
      },
    };
  };
  return Object.assign(factory, { configMaps, gets, credentials });
}

async function setup(
  opts: {
    kubeConfig?: string;
    access?: string;
    answers?: boolean[];
    helm?: ReturnType<typeof fakeHelm>;
    cluster?: ReturnType<typeof fakeCluster>;
  } = {},
) {
  const dir = await tempDir();
  const bare = await bareRemote(join(dir, 'remote'));
  const auditPath = join(dir, 'audit.jsonl');
  const path = await writeConfig(
    configYaml({
      auditPath: posixPath(auditPath),
      connectors: [
        '    github:',
        '      enabled: true',
        '      config: {repos: [acme/node-api]}',
        "      secrets: {token: '${env:GITHUB_TOKEN}'}",
        '    kubernetes:',
        '      enabled: true',
        `      access: ${opts.access ?? 'read-write-approved'}`,
        `      config: {${opts.kubeConfig ?? 'namespaces: [api], sandbox: test-sandbox'}}`,
        "      secrets: {kubeconfig: '${env:KUBECONFIG_TEXT}', awsAccessKeyId: '${env:AWS_ID}', awsSecretAccessKey: '${env:AWS_KEY}'}",
      ].join('\n'),
    }),
    dir,
  );
  const helm = opts.helm ?? fakeHelm();
  const cluster = opts.cluster ?? fakeCluster();
  const t = testContext({
    env: {
      GITHUB_TOKEN: 'ghp_sandboxTestToken0123456789abcdefABCD', // gitleaks:allow
      KUBECONFIG_TEXT: KUBECONFIG,
      AWS_ID: 'AKIASANDBOXTEST0001', // gitleaks:allow
      AWS_KEY: AWS_SECRET,
    },
    launcher: fakeLauncher(),
    prompter: scriptedPrompter(opts.answers ?? [true]),
    exec: helm,
    gitRemote: () => bare,
    sandboxCluster: cluster,
    sandboxStableMs: 1,
  });
  const audit = async () =>
    (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
  const sha = (await git(['--git-dir', bare, 'rev-parse', 'main'])).stdout.trim();
  return { dir, path, helm, cluster, t, audit, sha, auditPath };
}

async function runtimeOf(s: { path: string; t: ReturnType<typeof testContext> }) {
  const runtime = await startRuntime(s.path, s.t.ctx);
  if (!runtime) throw new Error(s.t.output());
  return runtime;
}

const idOf = (output: string) => /as kt-([0-9a-f]{8})/.exec(output)?.[1] ?? '';

describe('sandbox deploy (B2)', () => {
  it('deploys the CI image with its chart, tests it, and destroys only what it made', async () => {
    const s = await setup();
    const code = await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx);
    const out = s.t.output();
    expect(code, out).toBe(0);
    const id = idOf(out);
    expect(id).toMatch(/^[0-9a-f]{8}$/);

    const install = s.helm.calls.find((c) => c.args[0] === 'install');
    expect(install?.args).toEqual(
      expect.arrayContaining([
        `kt-${id}`,
        '-n',
        'test-sandbox',
        '--wait',
        `kodra.io/owner=kodra-agent,kodra.io/agent=test-agent,kodra.io/test=${id}`,
        'image.repository=ghcr.io/acme/node-api',
        // The default branch: the tag CI pushes for the commit.
        `image.tag=${s.sha}`,
      ]),
    );
    const envFrom = install?.args.find((a) => a.startsWith('extraEnvFrom='));
    expect(JSON.parse(envFrom?.slice('extraEnvFrom='.length) ?? '[]')).toEqual([
      { configMapRef: { name: `kt-${id}-placeholders` } },
      { secretRef: { name: 'node-api-sandbox-env', optional: true } },
    ]);
    // Credentials reach Helm through its environment, never its arguments.
    const env = install?.opts?.env ?? {};
    expect(env['HELM_DRIVER']).toBe('configmap');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe(AWS_SECRET);
    expect(await readFile(env['KUBECONFIG'] ?? '', 'utf8').catch(() => 'removed')).toBe('removed');
    for (const c of s.helm.calls) {
      expect(c.args.join(' ')).not.toContain('sandbox-kubeconfig-canary');
      expect(c.args.join(' ')).not.toContain(AWS_SECRET);
    }

    // The smoke test called the service, then everything was removed.
    expect(s.cluster.gets).toEqual([`kt-${id}-node-api:http/healthz`]);
    expect(s.helm.calls.map((c) => c.args[0])).toEqual(['install', 'list', 'uninstall']);
    expect(s.helm.releases).toEqual([]);
    expect(s.cluster.configMaps.size).toBe(0);
    expect(await readTests(join(s.dir, 'sandbox.json'))).toEqual([]);
    expect(out).toContain('passed');
    expect(out).toContain('Destroyed.');

    const records = await s.audit();
    const events = records.filter((r) => r.actor === 'sandbox' || r.task === `sandbox-${id}`);
    expect(events.map((r) => `${r.event}:${r.tool ?? ''}:${r.decision ?? ''}`)).toEqual([
      'task.start::',
      'approval.request:sandbox test:',
      'approval.decision:sandbox test:approved',
      'tool.call:helm install:approved',
      'tool.call:helm uninstall:allowed',
      'result::',
    ]);
    expect(JSON.stringify(records)).not.toContain('sandbox-kubeconfig-canary');
    expect(JSON.stringify(records)).not.toContain(AWS_SECRET);
  });

  it('gives secrets placeholders, never values', async () => {
    const created: Record<string, string>[] = [];
    const cluster = fakeCluster();
    const s = await setup({
      cluster: Object.assign(
        (k?: string, e?: Readonly<Record<string, string>>) => {
          const c = cluster(k, e);
          return {
            ...c,
            createConfigMap: (
              ns: string,
              n: string,
              l: Record<string, string>,
              d: Record<string, string>,
            ) => {
              created.push(d);
              return c.createConfigMap(ns, n, l, d);
            },
          };
        },
        { configMaps: cluster.configMaps, gets: cluster.gets, credentials: cluster.credentials },
      ),
    });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(0);
    expect(created).toEqual([{ DATABASE_PASSWORD: 'sandbox-placeholder' }]);
  });

  it('tests a branch with its pr- tag, keeps it, and the sweep destroys it when its time is up', async () => {
    const s = await setup();
    const code = await main(
      [
        'sandbox',
        'deploy',
        'acme/node-api',
        '--branch',
        'feature/x',
        '--keep',
        '2h',
        '--config',
        s.path,
      ],
      s.t.ctx,
    );
    expect(code, s.t.output()).toBe(0);
    const id = idOf(s.t.output());
    expect(s.helm.calls.find((c) => c.args[0] === 'install')?.args).toContain(
      `image.tag=pr-${s.sha}`,
    );
    expect(s.helm.calls.some((c) => c.args[0] === 'uninstall')).toBe(false);
    expect(s.t.output()).toContain(`kodra-agent sandbox destroy ${id}`);

    const runtime = await runtimeOf(s);
    try {
      const [test] = await sandboxList(runtime);
      expect(test?.result).toBe('passed');
      const until = Date.parse(test?.expiresAt ?? '');
      expect(until - Date.now()).toBeGreaterThan(110 * 60_000);
      // Not yet.
      expect((await sandboxSweep(s.t.ctx, runtime)).destroyed).toEqual([]);
      expect(await sandboxSweep(s.t.ctx, runtime, until + 1000)).toEqual({
        destroyed: [`kt-${id}`],
        problems: [],
      });
      expect(s.helm.releases).toEqual([]);
      expect(await sandboxList(runtime)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it('deploys nothing without an approval', async () => {
    const s = await setup({ answers: [false] });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(1);
    expect(s.t.output()).toContain('Not approved. Nothing was deployed.');
    expect(s.helm.calls).toEqual([]);
    expect(s.cluster.configMaps.size).toBe(0);
  });

  it('says why the image did not start, and still cleans up', async () => {
    const helm = fakeHelm({ installFails: 'Error: context deadline exceeded' });
    const cluster = fakeCluster({
      pods: [{ name: 'p', ready: false, restarts: 0, waiting: 'ImagePullBackOff' }],
    });
    const s = await setup({ helm, cluster });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(1);
    const out = s.t.output();
    expect(out).toContain('failed');
    expect(out).toContain('could not pull ghcr.io/acme/node-api:');
    expect(out).toContain('sandboxPullSecret');
    expect(helm.releases).toEqual([]);
    expect(cluster.configMaps.size).toBe(0);
  });

  it('fails the test when the service answers with a server error', async () => {
    const s = await setup({ cluster: fakeCluster({ status: 503 }) });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(1);
    expect(s.t.output()).toContain('GET /healthz: 503 (failed)');
  });

  it.each([
    ['namespaces: [api, test-sandbox], sandbox: test-sandbox', 'cannot be the sandbox'],
    ['namespaces: [api], sandbox: default', 'cannot be the sandbox'],
    ['namespaces: [api], sandbox: kube-system', 'cannot be the sandbox'],
    ['namespaces: [api], sandbox: kodra-agent', 'cannot be the sandbox'],
    ['namespaces: [api]', 'No sandbox namespace is set'],
  ])('refuses the sandbox with %s', async (kubeConfig, message) => {
    const s = await setup({ kubeConfig });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(1);
    expect(s.t.output()).toContain(message);
    expect(s.helm.calls).toEqual([]);
  });

  it('needs read-write-approved access', async () => {
    const s = await setup({ access: 'read-only' });
    expect(await main(['sandbox', 'deploy', 'acme/node-api', '--config', s.path], s.t.ctx)).toBe(1);
    expect(s.t.output()).toContain('read-write-approved');
    expect(s.helm.calls).toEqual([]);
  });

  it('checks --keep and --tag', async () => {
    const s = await setup();
    for (const args of [
      ['--keep', '25h'],
      ['--keep', 'soon'],
      ['--tag', 'a b'],
    ]) {
      expect(
        await main(['sandbox', 'deploy', 'acme/node-api', ...args, '--config', s.path], s.t.ctx),
      ).toBe(2);
    }
    expect(s.helm.calls).toEqual([]);
  });
});

describe('sandbox destroy and sweep (B2)', () => {
  const old = '2026-10-01 10:00:00.5 +0000 UTC';
  const ours = { 'kodra.io/owner': 'kodra-agent', 'kodra.io/agent': 'test-agent' };

  it('destroys only tests in its list, and only releases with its labels', async () => {
    const helm = fakeHelm({
      releases: [
        // Same name, but not ours: another agent's test.
        {
          name: 'kt-0000aaaa',
          labels: { ...ours, 'kodra.io/agent': 'other', 'kodra.io/test': '0000aaaa' },
          updated: old,
        },
      ],
    });
    const s = await setup({ helm });
    const runtime = await runtimeOf(s);
    try {
      expect(await sandboxDestroy(s.t.ctx, runtime, '0000aaaa', 'test')).toEqual({
        ok: false,
        reason: "No sandbox test 0000aaaa. Only the agent's own tests can be destroyed.",
      });
      await writeFile(
        join(s.dir, 'sandbox.json'),
        JSON.stringify([
          {
            id: '0000aaaa',
            release: 'kt-0000aaaa',
            namespace: 'test-sandbox',
            repo: 'acme/node-api',
            branch: 'main',
            sha: 'x',
            image: 'i',
            requestedBy: 't',
            createdAt: '',
            expiresAt: '2026-10-01T00:00:00Z',
          },
        ]),
      );
      // In the list (a forged entry), but Helm says the release is not ours: left alone.
      expect(await sandboxDestroy(s.t.ctx, runtime, '0000aaaa', 'test')).toEqual({ ok: true });
      expect(helm.calls.some((c) => c.args[0] === 'uninstall')).toBe(false);
      expect(helm.releases).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('sweeps our left-over releases older than a day, and nothing else', async () => {
    const recent = new Date(Date.now() - 60 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', ' +0000 UTC');
    const helm = fakeHelm({
      releases: [
        { name: 'kt-11111111', labels: { ...ours, 'kodra.io/test': '11111111' }, updated: old },
        { name: 'kt-22222222', labels: { ...ours, 'kodra.io/test': '22222222' }, updated: recent },
        {
          name: 'kt-33333333',
          labels: { ...ours, 'kodra.io/agent': 'other', 'kodra.io/test': '33333333' },
          updated: old,
        },
        { name: 'payments', labels: { ...ours, 'kodra.io/test': 'x' }, updated: old },
      ],
    });
    const s = await setup({ helm });
    const runtime = await runtimeOf(s);
    try {
      expect(await sandboxSweep(s.t.ctx, runtime)).toEqual({
        destroyed: ['kt-11111111'],
        problems: [],
      });
      expect(helm.releases.map((r) => r.name)).toEqual(['kt-22222222', 'kt-33333333', 'payments']);
    } finally {
      await runtime.close();
    }
  });

  it('sweeps nothing when there is no sandbox', async () => {
    const s = await setup({ kubeConfig: 'namespaces: [api]' });
    const runtime = await runtimeOf(s);
    try {
      expect(await sandboxSweep(s.t.ctx, runtime)).toEqual({ destroyed: [], problems: [] });
      expect(s.helm.calls).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
});

describe('sandbox helpers', () => {
  it('reads Helm times', () => {
    expect(helmTime('2026-10-29 10:04:05.123456789 +0300 +03')).toBe(
      Date.parse('2026-10-29T07:04:05.123Z'),
    );
    expect(Number.isNaN(helmTime(undefined))).toBe(true);
  });

  it('parses --keep', () => {
    expect(parseKeep('0')).toBe(0);
    expect(parseKeep('30m')).toBe(30 * 60_000);
    expect(parseKeep('2h')).toBe(2 * 3_600_000);
    expect(parseKeep('24h')).toBe(MAX_KEEP_MS);
    expect(parseKeep('25h')).toBeNull();
    expect(parseKeep('soon')).toBeNull();
  });
});
