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
    expect(t.output()).toContain(
      'Created a console sign-in token for the team (view and chat) in .env (KODRA_CONSOLE_TOKEN)',
    );
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

  it('checks each database on its own, once its tunnel key is entered too', async () => {
    server = await anthropicServer('good-key-1234');
    // Nothing listens on port 1, so every check fails fast; what matters is which runs when.
    const { dir, path } = await setup(
      [
        '    databases:',
        '      enabled: true',
        '      config:',
        '        databases:',
        '          - name: orders',
        '            engine: mariadb',
        '            host: 127.0.0.1',
        '            port: 1',
        '            user: kodra_monitor',
        '            password: ${env:KODRA_DB_ORDERS_PASSWORD}',
        '          - name: billing',
        '            engine: postgres',
        '            host: 127.0.0.1',
        '            port: 1',
        '            user: kodra_monitor',
        '            password: ${env:KODRA_DB_BILLING_PASSWORD}',
        '            tunnelHost: 127.0.0.1',
        '            tunnelPort: 1',
        '            tunnelUser: kodra',
        `            tunnelHostKey: SHA256:${'A'.repeat(43)}`,
        '            tunnelKey: ${env:KODRA_DB_BILLING_TUNNEL_KEY}',
      ].join('\n'),
    );
    const prompter = scriptedPrompter([
      'good-key-1234',
      'orders-pw-1234',
      'keep',
      'billing-pw-1234',
      'not-a-key',
      'keep',
    ]);
    const t = testContext({ prompter, endpoints: { anthropic: server.url } });

    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    const out = t.output();
    const lines = out.split('\n');
    const orders = lines.find((l) => l.includes('FAIL  Databases orders.password'));
    expect(orders).toContain('orders: down');
    expect(orders).not.toContain('billing');
    expect(out).toContain(
      'SKIP  Databases billing.password (KODRA_DB_BILLING_PASSWORD): checked once billing.tunnelKey is entered',
    );
    const billing = lines.find((l) => l.includes('FAIL  Databases billing.tunnelKey'));
    expect(billing).toContain('billing: down');
    expect(billing).not.toContain('orders');
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain('KODRA_DB_ORDERS_PASSWORD=orders-pw-1234'); // gitleaks:allow
    expect(env).toContain('KODRA_DB_BILLING_TUNNEL_KEY=not-a-key');
    expect(out).not.toContain('billing-pw-1234');
  });
});

describe('init with no secrets to ask for', () => {
  const noSecrets = async (console: boolean) => {
    const dir = await tempDir();
    const yaml = configYaml({
      auditPath: posixPath(join(dir, 'audit.jsonl')),
      model: '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:9',
    });
    const path = await writeConfig(console ? yaml : `${yaml}  console:\n    enabled: false\n`, dir);
    return { dir, path };
  };

  it('still creates the console token, without asking anything', async () => {
    const { dir, path } = await noSecrets(true);
    const t = testContext({ prompter: scriptedPrompter([]) });
    expect(await init({ ...base, configPath: path, nonInteractive: true }, t.ctx)).toBe(0);
    expect(await readFile(join(dir, '.env'), 'utf8')).toMatch(/^KODRA_CONSOLE_TOKEN=\S{43}$/m);
  });

  it('creates one token per console approver, once', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        approvers: ['U01OMAR', 'console:on-call'],
      }),
      dir,
    );
    const t = testContext();
    expect(await init({ ...base, configPath: path, nonInteractive: true }, t.ctx)).toBe(0);
    const env = await readFile(join(dir, '.env'), 'utf8');
    const shared = /^KODRA_CONSOLE_TOKEN=(\S{43})$/m.exec(env)?.[1];
    const own = /^KODRA_CONSOLE_TOKEN_ON_CALL=(\S{43})$/m.exec(env)?.[1];
    expect(shared).toBeDefined();
    expect(own).toBeDefined();
    expect(own).not.toBe(shared);
    expect(t.output()).toContain('for console:on-call in .env (KODRA_CONSOLE_TOKEN_ON_CALL)');
    expect(t.output()).not.toContain(own);

    expect(await init({ ...base, configPath: path, nonInteractive: true }, testContext().ctx)).toBe(
      0,
    );
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(env);
  });

  it('has nothing to do with the console off', async () => {
    const { dir, path } = await noSecrets(false);
    const t = testContext();
    expect(await init({ ...base, configPath: path, nonInteractive: true }, t.ctx)).toBe(0);
    expect(t.output()).toContain('This configuration needs no secrets. Nothing to do.');
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
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

  it("adds each console approver's token and says how to read it", async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        target: 'kubernetes',
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        approvers: ['console:omar'],
      }),
      dir,
    );
    const k8s = fakeKubernetes();
    const t = testContext({ kubernetes: k8s });
    expect(await init({ ...base, configPath: path, nonInteractive: true }, t.ctx)).toBe(0);
    const data = (k8s.calls.find((c) => c.op === 'upsertSecret')?.args[2] ?? {}) as Record<
      string,
      string
    >;
    expect(Object.keys(data).sort()).toEqual(['KODRA_CONSOLE_TOKEN', 'KODRA_CONSOLE_TOKEN_OMAR']);
    expect(t.output()).toContain(
      "The console sign-in token for console:omar is key KODRA_CONSOLE_TOKEN_OMAR of that Secret: kubectl --namespace kodra-agent get secret test-agent-secrets -o jsonpath='{.data.KODRA_CONSOLE_TOKEN_OMAR}' | base64 -d",
    );
    expect(t.output()).not.toContain(data['KODRA_CONSOLE_TOKEN_OMAR']);

    const dry = testContext();
    expect(await init({ ...base, configPath: path, dryRun: true }, dry.ctx)).toBe(0);
    expect(dry.output()).toContain(
      'KODRA_CONSOLE_TOKEN_OMAR: "<a long random string: the sign-in token for console:omar>"',
    );
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

describe('init and approver names', () => {
  const SLACK =
    "    slack:\n      enabled: true\n      config: {channel: '#ops'}\n      secrets: {botToken: '${env:SLACK_BOT_TOKEN}', appToken: '${env:SLACK_APP_TOKEN}'}";
  const members = [
    { id: 'U01OMAR', name: 'omar', profile: { display_name: 'Omar', real_name: 'Omar A' } },
    { id: 'U03ALEX', name: 'alex1', profile: { display_name: 'alex' } },
    { id: 'U04ALEX', name: 'alex2', profile: { display_name: 'alex' } },
  ];

  async function slackSetup(approvers: string[]) {
    server = await fakeServer({
      '/v1/models': (_q, res) => {
        json(res, 200, { data: [] });
      },
      'POST /api/auth.test': (_q, res) => {
        json(res, 200, { ok: true });
      },
      'POST /api/apps.connections.open': (_q, res) => {
        json(res, 200, { ok: true });
      },
      'POST /api/users.list': (_q, res) => {
        json(res, 200, { ok: true, members });
      },
    });
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit', 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: SLACK,
        approvers,
      }),
      dir,
    );
    const env = {
      ANTHROPIC_API_KEY: 'k',
      SLACK_BOT_TOKEN: 'xoxb-names-test',
      SLACK_APP_TOKEN: 'xapp-names-test',
    };
    return { dir, path, env, endpoints: { anthropic: server.url, slack: server.url } };
  }

  it('looks names up once, shows who matched, and writes the ids after a yes', async () => {
    const { path, env, endpoints } = await slackSetup(['@omar', 'console:omar']);
    // The key and two tokens, then yes to writing the ids.
    const prompter = scriptedPrompter(['k', 'xoxb-names-test', 'xapp-names-test', true]);
    const t = testContext({ prompter, env, endpoints });
    expect(await init({ ...base, configPath: path }, t.ctx)).toBe(0);
    expect(t.output()).toContain('@omar -> U01OMAR (Omar A)');
    const config = await readFile(path, 'utf8');
    expect(config).toMatch(/approvers: \[ *'U01OMAR', 'console:omar' *\]/);
    expect(config).not.toContain('@omar');
    expect(t.output()).not.toContain('xoxb-names-test');
  });

  it('with --non-interactive, writes nothing when a name is ambiguous', async () => {
    const { dir, path, env, endpoints } = await slackSetup(['@omar', '@alex']);
    const before = await readFile(path, 'utf8');
    const t = testContext({ env, endpoints });
    expect(await init({ ...base, nonInteractive: true, configPath: path }, t.ctx)).toBe(1);
    expect(t.term.stderr.join('\n')).toContain(
      '@alex matches 2 people (U03ALEX, U04ALEX). Use the right user id instead.',
    );
    expect(t.term.stderr.at(-1)).toBe('Nothing was written.');
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
  });

  it('with --non-interactive, writes the ids when every name matches one person', async () => {
    const { path, env, endpoints } = await slackSetup(['@omar']);
    const t = testContext({ env, endpoints });
    expect(await init({ ...base, nonInteractive: true, configPath: path }, t.ctx)).toBe(0);
    expect(await readFile(path, 'utf8')).toContain('U01OMAR');
    expect(t.output()).toContain('Wrote 1 Slack user id into');
  });
});
