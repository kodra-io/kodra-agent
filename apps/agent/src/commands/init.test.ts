import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configYaml,
  fakeKubernetes,
  fakeServer,
  json,
  posixPath,
  scriptedPrompter,
  tempDir,
  testContext,
  writeConfig,
} from '../test-helpers.ts';
import { init } from './init.ts';

type Server = Awaited<ReturnType<typeof fakeServer>>;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const base = { nonInteractive: false, dryRun: false };

async function anthropicServer(validKey: string) {
  return fakeServer({
    '/v1/models': (req, res) => {
      json(res, req.headers['x-api-key'] === validKey ? 200 : 401, { data: [] });
    },
  });
}

async function setup(connectors = '    {}', target: 'compose' | 'kubernetes' = 'compose') {
  const dir = await tempDir();
  const path = await writeConfig(
    configYaml({
      target,
      auditPath: posixPath(join(dir, 'audit', 'audit.jsonl')),
      model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
      connectors,
    }),
    dir,
  );
  return { dir, path };
}

describe('init on compose', () => {
  it('asks with hidden input, checks the key, and writes an owner-only .env', async () => {
    server = await anthropicServer('good-key-1234');
    const { dir, path } = await setup();
    const prompter = scriptedPrompter(['good-key-1234']);
    const t = testContext({ prompter, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(prompter.asked).toEqual(['Anthropic apiKey (ANTHROPIC_API_KEY):']);
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain('ANTHROPIC_API_KEY=good-key-1234');
    expect(t.output()).toContain('PASS  Anthropic apiKey (ANTHROPIC_API_KEY): API key accepted');
    expect(t.output()).not.toContain('good-key-1234');
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    }
  });

  it('lets the user retry after a failed check, then keeps the good value', async () => {
    server = await anthropicServer('good-key-1234');
    const { dir, path } = await setup();
    const prompter = scriptedPrompter(['bad-key-5678', 'retry', 'good-key-1234']);
    const t = testContext({ prompter, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(t.term.stderr.join('\n')).toContain(
      'FAIL  Anthropic apiKey (ANTHROPIC_API_KEY): HTTP 401',
    );
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('ANTHROPIC_API_KEY=good-key-1234');
    expect(t.output()).not.toContain('bad-key-5678');
  });

  it('writes nothing when the user stops', async () => {
    server = await anthropicServer('good-key-1234');
    const { dir, path } = await setup();
    const prompter = scriptedPrompter(['bad-key-5678', 'abort']);
    const t = testContext({ prompter, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(1);
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
  });

  it('offers to keep values already in .env and keeps other keys untouched', async () => {
    const { dir, path } = await setup();
    await writeFile(join(dir, '.env'), 'MY_OWN=stay\nANTHROPIC_API_KEY=existing-key-999\n');
    const prompter = scriptedPrompter([true]);
    const t = testContext({ prompter });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(prompter.asked).toEqual([
      'Anthropic apiKey (ANTHROPIC_API_KEY) is already set. Keep it?',
    ]);
    const env = await readFile(join(dir, '.env'), 'utf8');
    // Existing keys untouched; a console sign-in token is added once, never printed.
    expect(env.startsWith('MY_OWN=stay\nANTHROPIC_API_KEY=existing-key-999\n')).toBe(true);
    const token = /^KODRA_CONSOLE_TOKEN=([A-Za-z0-9_-]{43})$/m.exec(env)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(t.output()).not.toContain('existing-key-999');
    expect(t.output()).not.toContain(token);
    expect(t.output()).toContain('Created a console sign-in token in .env (KODRA_CONSOLE_TOKEN)');
    // A second run keeps the same token.
    const again = testContext({ prompter: scriptedPrompter([true]) });
    expect(await init({ ...base, configPath: path }, again.ctx)).toBe(0);
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain(`KODRA_CONSOLE_TOKEN=${token}`);
  });

  it('copies a file secret into ./secrets with owner-only permissions', async () => {
    const { dir, path } = await setup(
      "    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
    );
    await writeFile(join(dir, 'my-kubeconfig'), 'apiVersion: v1\nkind: Config\n');
    const k8s = fakeKubernetes();
    server = await anthropicServer('good-key-1234');
    const prompter = scriptedPrompter(['good-key-1234', 'my-kubeconfig']);
    const t = testContext({ prompter, kubernetes: k8s, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(await readFile(join(dir, 'secrets', 'kubeconfig'), 'utf8')).toBe(
      'apiVersion: v1\nkind: Config\n',
    );
    expect(k8s.calls[0]).toMatchObject({
      op: 'listPods',
      kubeconfig: 'apiVersion: v1\nkind: Config',
      args: ['api', 2000],
    });
  });

  it('says where a file secret goes, uses it on Enter, and explains a folder', async () => {
    const { dir, path } = await setup(
      "    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
    );
    await mkdir(join(dir, 'dot-kube'));
    server = await anthropicServer('good-key-1234');
    // A folder first (the common mistake), then Enter once the file is in secrets/.
    const prompter = scriptedPrompter(['good-key-1234', 'dot-kube', '']);
    const original = prompter.text.bind(prompter);
    prompter.text = async (m) => {
      if (prompter.asked.length === 2) {
        await mkdir(join(dir, 'secrets'), { recursive: true });
        await writeFile(join(dir, 'secrets', 'kubeconfig'), 'apiVersion: v1\nkind: Config\n');
      }
      return original(m);
    };
    const t = testContext({
      prompter,
      kubernetes: fakeKubernetes(),
      endpoints: { anthropic: server.url },
    });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    const out = t.output();
    expect(out).toContain(
      'copy the file into this bundle folder as secrets/kubeconfig (the agent reads it at /secrets/kubeconfig)',
    );
    expect(prompter.asked).toContain(
      'Path to the file for Kubernetes kubeconfig (file /secrets/kubeconfig), or Enter once it is in place:',
    );
    expect(out).toContain('dot-kube is a folder. Give the file itself');
    expect(await readFile(join(dir, 'secrets', 'kubeconfig'), 'utf8')).toBe(
      'apiVersion: v1\nkind: Config\n',
    );
  });

  it('skips an optional secret on an empty answer', async () => {
    const { dir, path } = await setup(
      "    prometheus:\n      enabled: true\n      config: {url: 'http://127.0.0.1:1'}\n      secrets: {bearerToken: '${env:PROMETHEUS_TOKEN}'}",
    );
    server = await anthropicServer('good-key-1234');
    const prompter = scriptedPrompter(['good-key-1234', '']);
    const t = testContext({ prompter, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(prompter.asked[1]).toBe(
      'Prometheus bearerToken (PROMETHEUS_TOKEN) (optional, Enter to skip):',
    );
    expect(await readFile(join(dir, '.env'), 'utf8')).not.toContain('PROMETHEUS_TOKEN');
  });
});

describe('init --non-interactive', () => {
  it('reads values from the environment and checks them', async () => {
    server = await anthropicServer('ci-key-1234');
    const { dir, path } = await setup();
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'ci-key-1234' },
      endpoints: { anthropic: server.url },
    });

    expect(await init({ ...base, nonInteractive: true, configPath: path }, t.ctx)).toBe(0);
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('ANTHROPIC_API_KEY=ci-key-1234');
  });

  it('fails with the list of what is missing and writes nothing', async () => {
    const { dir, path } = await setup(
      "    github:\n      enabled: true\n      config: {repos: [a/b]}\n      secrets: {token: '${env:GITHUB_TOKEN}'}",
    );
    const t = testContext();
    expect(await init({ ...base, nonInteractive: true, configPath: path }, t.ctx)).toBe(1);
    expect(t.term.stderr).toEqual([
      'Missing Anthropic apiKey (ANTHROPIC_API_KEY).',
      'Missing GitHub token (GITHUB_TOKEN).',
      'Nothing was written.',
    ]);
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
  });

  it('refuses to prompt without a terminal', async () => {
    const { path } = await setup();
    const t = testContext({ prompter: null });
    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(1);
    expect(t.term.stderr[0]).toContain('--non-interactive');
  });
});

describe('init on kubernetes', () => {
  it('creates the Secret with env names and file keys', async () => {
    server = await anthropicServer('k-key-1234');
    const { dir, path } = await setup(
      "    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
      'kubernetes',
    );
    await writeFile(join(dir, 'kc'), 'kube-contents\n');
    const k8s = fakeKubernetes();
    const prompter = scriptedPrompter(['k-key-1234', 'kc']);
    const t = testContext({ prompter, kubernetes: k8s, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    const upsert = k8s.calls.find((c) => c.op === 'upsertSecret');
    const [ns, name, data] = (upsert?.args ?? []) as [string, string, Record<string, string>];
    expect([ns, name]).toEqual(['kodra-agent', 'test-agent-secrets']);
    expect(data).toMatchObject({ ANTHROPIC_API_KEY: 'k-key-1234', kubeconfig: 'kube-contents' });
    expect(data['KODRA_CONSOLE_TOKEN']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.term.stdout).toContain('Created Secret kodra-agent/test-agent-secrets with 3 key(s).');
    expect(t.output()).not.toContain(data['KODRA_CONSOLE_TOKEN']);
    expect(t.output()).not.toContain('k-key-1234');
  });

  it('--dry-run prints placeholders, asks nothing, and never reads values', async () => {
    const { path } = await setup(
      "    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
      'kubernetes',
    );
    const t = testContext({ env: { ANTHROPIC_API_KEY: 'should-never-print-1234' } });
    expect(
      await init({ ...base, dryRun: true, namespace: 'agents', configPath: path }, t.ctx),
    ).toBe(0);
    const out = t.term.stdout.join('\n');
    expect(out).toContain('name: test-agent-secrets');
    expect(out).toContain('namespace: agents');
    expect(out).toContain('ANTHROPIC_API_KEY: <ANTHROPIC_API_KEY>');
    expect(out).toContain('kubeconfig: <contents of your kubeconfig file>');
    expect(out).toContain('--from-env-file=.env');
    expect(out).toContain('--from-file=kubeconfig=<path to kubeconfig>');
    expect(out).not.toContain('should-never-print-1234');
  });

  it('reports a failed Secret write without details that could hold values', async () => {
    server = await anthropicServer('k-key-1234');
    const { path } = await setup('    {}', 'kubernetes');
    const k8s = fakeKubernetes({
      upsertSecret: () =>
        Promise.reject(Object.assign(new Error('body had k-key-1234'), { code: 403 })),
    });
    const t = testContext({
      prompter: scriptedPrompter(['k-key-1234']),
      kubernetes: k8s,
      endpoints: { anthropic: server.url },
    });
    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(1);
    expect(t.term.stderr).toContain(
      'Could not write Secret kodra-agent/test-agent-secrets (HTTP 403).',
    );
    expect(t.output()).not.toContain('k-key-1234');
  });
});
