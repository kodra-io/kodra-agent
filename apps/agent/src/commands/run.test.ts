import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { fakeLauncher } from '../test-fixtures/fake-connector.ts';
import {
  asStreamResult,
  configYaml,
  fakeSelfKubernetes,
  fakeServer,
  fakeSlack,
  json,
  posixPath,
  tempDir,
  testContext,
  writeConfig,
} from '../test-helpers.ts';

const KUBE_TOKEN = 'canary-run-kube-token-4b7e9d1c';
const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const call = (toolName: string, input: Record<string, unknown>) => ({
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: `c-${toolName}-${String(Math.random())}`,
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

/** One model for both investigations and Slack turns, scripted by what it is asked. */
function scriptedModel() {
  const generate = (options: Parameters<MockLanguageModelV4['doGenerate']>[0]) => {
    const prompt = JSON.stringify(options.prompt);
    const toolTurns = options.prompt.filter((m) => m.role === 'tool').length;
    if (prompt.includes('A monitoring alert is firing')) {
      if (toolTurns === 0)
        return Promise.resolve(
          call('kubernetes__pods_log', { namespace: 'payments', name: 'web-1' }),
        );
      return Promise.resolve(
        say('The database is unreachable. Suggested fix: check the db service.'),
      );
    }
    if (toolTurns === 0) {
      return Promise.resolve(
        call('kubernetes__resources_scale', {
          namespace: 'payments',
          name: 'web',
          scale: 2,
          kodra_reason: 'more capacity',
        }),
      );
    }
    return Promise.resolve(say('Scaled web to 2.'));
  };
  // Slack and the monitor generate; the console streams. Both get the same answers.
  return new MockLanguageModelV4({
    doGenerate: generate,
    doStream: async (options) => asStreamResult(await generate(options)),
  });
}

let alertmanager: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await alertmanager?.close();
  alertmanager = undefined;
});

async function until<T>(check: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('kodra-agent run', () => {
  it(
    'serves health, investigates an alert read-only, and runs an approved change from Slack',
    { timeout: 60_000 },
    async () => {
      alertmanager = await fakeServer({
        '/api/v2/alerts': (_q, s) => {
          json(s, 200, [
            {
              fingerprint: 'fp-crash',
              labels: { alertname: 'PodCrashLooping', severity: 'critical', namespace: 'payments' },
              annotations: { summary: 'web-1 keeps restarting' },
              startsAt: '2026-10-03T10:00:00Z',
            },
          ]);
        },
      });
      const dir = await tempDir();
      const kubeconfig = join(dir, 'kubeconfig');
      await writeFile(kubeconfig, `apiVersion: v1\nusers:\n- user:\n    token: ${KUBE_TOKEN}\n`);
      const auditPath = join(dir, 'audit', 'audit.jsonl');
      const path = await writeConfig(
        configYaml({
          auditPath: posixPath(auditPath),
          model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
          connectors: [
            '    kubernetes:',
            '      enabled: true',
            '      access: read-write-approved',
            '      config: {namespaces: [payments]}',
            `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfig)}}'}`,
            '    prometheus:',
            '      enabled: true',
            `      config: {url: 'http://127.0.0.1:1', alertmanagerUrl: '${alertmanager.url}', pollIntervalSeconds: 3600}`,
            '    slack:',
            '      enabled: true',
            "      config: {channel: '#ops'}",
            "      secrets: {botToken: '${env:SLACK_BOT_TOKEN}', appToken: '${env:SLACK_APP_TOKEN}'}",
          ].join('\n'),
        }),
        dir,
      );

      const slack = fakeSlack([{ id: 'U01OMAR', name: 'omar', displayName: 'Omar' }]);
      const model = scriptedModel();
      const stop = new AbortController();
      let healthPort = 0;
      const t = testContext({
        env: { ANTHROPIC_API_KEY: 'k', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' },
        modelFactory: () => model,
        launcher: fakeLauncher(),
        slackConnection: () => slack.connection(),
        stopSignal: stop.signal,
        healthPort: 0,
        onReady: (info) => {
          healthPort = info.healthPort;
        },
      });
      const running = main(['run', '--config', path], t.ctx);

      // Health and hello.
      await until(() => (healthPort ? true : undefined));
      expect((await fetch(`http://127.0.0.1:${String(healthPort)}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${String(healthPort)}/readyz`)).status).toBe(200);
      expect(slack.posted[0]).toMatchObject({ channel: 'C0CHANNEL' });
      expect(slack.posted[0]?.text).toContain('Kodra AI Agent is online');

      // The alert is investigated once, read-only, and the findings are posted.
      const findings = await until(() =>
        slack.posted.find((p) => p.text.includes('*PodCrashLooping*')),
      );
      expect(findings.text).toContain('The database is unreachable.');
      expect(findings.threadTs).toBeUndefined();

      // A mention asks for a change; the approval message appears in the thread.
      const mention = slack.handlers.onMention({
        user: 'U0ASKER',
        channel: 'C0CHANNEL',
        text: '<@U0BOT> scale web to 2',
        ts: '1700000500.000001',
      });
      const approval = await until(() =>
        slack.posted.find((p) => p.text.includes('needs approval')),
      );
      expect(approval.threadTs).toBe('1700000500.000001');
      const value =
        (
          approval.blocks?.find((b) => (b as { type: string }).type === 'actions') as {
            elements: { value: string }[];
          }
        ).elements[0]?.value ?? '';

      // Someone else's click is refused; the approver's click runs the change.
      await slack.handlers.onAction({ user: 'U0ASKER', actionId: 'kodra_approve', value });
      await slack.handlers.onAction({ user: 'U01OMAR', actionId: 'kodra_approve', value });
      await mention;
      const reply = slack.posted.find((p) => p.text.startsWith('Scaled web to 2.'));
      // Each answer ends with what it used.
      expect(reply?.text).toMatch(/\n_\d[\d,]* tokens in.*, \d[\d,]* out_$/);
      expect(reply?.threadTs).toBe('1700000500.000001');

      stop.abort();
      expect(await running).toBe(0);
      expect(slack.stopped).toBe(true);

      const audit = (await readFile(auditPath, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, string>);
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'approval.decision',
          actor: 'U0ASKER',
          decision: 'blocked',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'approval.decision',
          actor: 'U01OMAR',
          decision: 'approved',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          tool: 'resources_scale',
          decision: 'approved',
          actor: 'slack:U0ASKER',
        }),
      );
      // Investigations are read-only: the model is never even offered the write tool.
      const investigationTools = model.doGenerateCalls
        .filter((c) => JSON.stringify(c.prompt).includes('A monitoring alert is firing'))
        .flatMap((c) => (c.tools ?? []).map((t) => t.name));
      expect(investigationTools).toContain('kubernetes__pods_log');
      expect(investigationTools).not.toContain('kubernetes__resources_scale');

      // The kubeconfig token echoed by the server never reaches Slack, the model, or the audit log.
      const everything = [
        JSON.stringify(slack.posted),
        JSON.stringify(slack.updated),
        JSON.stringify(model.doGenerateCalls.map((c) => c.prompt)),
        await readFile(auditPath, 'utf8'),
        t.output(),
      ].join('\n');
      expect(everything).toContain('leaked kubeconfig');
      expect(everything.includes(KUBE_TOKEN)).toBe(false);
    },
  );

  it('keeps running when one connector cannot start, and says which', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: [
          '    kubernetes:',
          '      enabled: true',
          '      config: {namespaces: [payments]}',
          '    grafana:',
          '      enabled: true',
          "      config: {url: 'http://127.0.0.1:1'}",
          "      secrets: {serviceAccountToken: '${env:G}'}",
          '    slack:',
          '      enabled: true',
          "      config: {channel: '#ops'}",
          "      secrets: {botToken: '${env:B}', appToken: '${env:A}'}",
        ].join('\n'),
      }),
      dir,
    );
    const slack = fakeSlack();
    const stop = new AbortController();
    let healthPort = 0;
    const fake = fakeLauncher();
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k', G: 'grafana-token', B: 'xoxb-1', A: 'xapp-1' },
      modelFactory: () => scriptedModel(),
      // Grafana's server cannot start; Kubernetes's can.
      launcher: (manifest, runtime) =>
        manifest.id === 'grafana'
          ? { command: join(dir, 'no-such-server'), args: [] }
          : fake(manifest, runtime),
      slackConnection: () => slack.connection(),
      stopSignal: stop.signal,
      healthPort: 0,
      onReady: (info) => {
        healthPort = info.healthPort;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (healthPort ? true : undefined));

    const readyz = await fetch(`http://127.0.0.1:${String(healthPort)}/readyz`);
    expect(readyz.status).toBe(200);
    expect(await readyz.text()).toBe('ready; not available: Grafana');
    expect(t.term.stderr.join('\n')).toContain('Grafana is not available:');
    const hello = slack.posted[0]?.text ?? '';
    expect(hello).toContain('• Grafana: not available (');
    // Counts what the model is offered: reads only on a read-only connector.
    expect(hello).toContain('• Kubernetes: read-only, 1 tool\n');

    stop.abort();
    expect(await running).toBe(0);
  });

  it('pauses from the console (anyone), resumes (approvers only), and keeps it over a restart', async () => {
    const SHARED = 'run-pause-shared-token-77ac'; // gitleaks:allow
    const OMAR = 'run-pause-omar-token-19fe'; // gitleaks:allow
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model:
          '    provider: anthropic\n    name: claude-sonnet-5-5\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        approvers: ['@omar', 'console:omar'],
      }),
      dir,
    );
    const start = () => {
      const stop = new AbortController();
      let port = 0;
      const t = testContext({
        env: {
          ANTHROPIC_API_KEY: 'k',
          KODRA_CONSOLE_TOKEN: SHARED,
          KODRA_CONSOLE_TOKEN_OMAR: OMAR,
        },
        modelFactory: () => scriptedModel(),
        launcher: fakeLauncher(),
        stopSignal: stop.signal,
        healthPort: 0,
        consolePort: 0,
        consoleStaticDir: join(dir, 'no-build'),
        onReady: (info) => {
          port = info.consolePort ?? 0;
        },
      });
      const running = main(['run', '--config', path], t.ctx);
      return { stop, running, t, port: () => port };
    };
    const signIn = async (base: string, token: string) =>
      (
        (
          await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
        ).headers.get('set-cookie') ?? ''
      ).split(';')[0] ?? '';
    const act = (base: string, cookie: string, route: string) =>
      fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
        body: '{}',
      });

    const first = start();
    await until(() => (first.port() ? true : undefined));
    let base = `http://127.0.0.1:${String(first.port())}`;
    const team = await signIn(base, SHARED);
    expect((await act(base, team, 'agent/pause')).status).toBe(200);
    const status = (await (
      await fetch(`${base}/api/status`, { headers: { cookie: team } })
    ).json()) as {
      paused: { by: string } | null;
      budget: { limit: number | null };
    };
    expect(status.paused).toMatchObject({ by: 'console' });
    expect(status.budget.limit).toBeNull();
    // Without Slack, the notice goes to the terminal.
    await until(() =>
      first.t.output().includes('Changes are paused by console.') ? true : undefined,
    );
    expect((await act(base, team, 'agent/resume')).status).toBe(403);
    first.stop.abort();
    expect(await first.running).toBe(0);

    // Still paused after a restart; an approver resumes.
    const second = start();
    await until(() => (second.port() ? true : undefined));
    expect(second.t.output()).toContain('changes paused');
    base = `http://127.0.0.1:${String(second.port())}`;
    const omar = await signIn(base, OMAR);
    expect((await act(base, omar, 'agent/resume')).status).toBe(200);
    const overview = (await (
      await fetch(`${base}/api/overview`, { headers: { cookie: omar } })
    ).json()) as Record<string, unknown>;
    expect(overview).toMatchObject({ investigationsToday: 0, recentChanges: [] });
    second.stop.abort();
    expect(await second.running).toBe(0);
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"control","actor":"console"');
    expect(audit).toContain('"event":"control","actor":"console:omar"');
  });

  it('saves settings from the console, then exits so Compose restarts it', async () => {
    const SHARED = 'run-settings-shared-token-3b2a'; // gitleaks:allow
    const OMAR = 'run-settings-omar-token-6c5d'; // gitleaks:allow
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model:
          '    provider: anthropic\n    name: claude-sonnet-5-5\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        approvers: ['@omar', 'console:omar'],
      }),
      dir,
    );
    const stop = new AbortController();
    let port = 0;
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k', KODRA_CONSOLE_TOKEN: SHARED, KODRA_CONSOLE_TOKEN_OMAR: OMAR },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      stopSignal: stop.signal,
      healthPort: 0,
      consolePort: 0,
      consoleStaticDir: join(dir, 'no-build'),
      onReady: (info) => {
        port = info.consolePort ?? 0;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (port ? true : undefined));
    const base = `http://127.0.0.1:${String(port)}`;
    const signIn = async (token: string) =>
      (
        (
          await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
        ).headers.get('set-cookie') ?? ''
      ).split(';')[0] ?? '';
    const post = (cookie: string, route: string, body: unknown) =>
      fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
        body: JSON.stringify(body),
      });
    const patch = { limits: { monthlyBudgetUsd: 25 } };

    const team = await signIn(SHARED);
    expect((await post(team, 'settings/preview', { patch })).status).toBe(403);

    const omar = await signIn(OMAR);
    const view = (await (
      await fetch(`${base}/api/settings`, { headers: { cookie: omar } })
    ).json()) as {
      base: string;
      editable: boolean;
    };
    expect(view.editable).toBe(true);
    const saved = await post(omar, 'settings/apply', { patch, base: view.base });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ restarting: true });
    // run returns the restart code; Docker Compose starts the agent again.
    expect(await running).toBe(75);
    expect(t.output()).toContain('Restarting to apply the new settings.');
    expect(await readFile(path, 'utf8')).toContain('monthlyBudgetUsd: 25');
  });

  it('on Kubernetes, saves settings to its own ConfigMap and restarts its Deployment', async () => {
    const OMAR = 'run-k8s-omar-token-9d8c'; // gitleaks:allow
    const dir = await tempDir();
    const text = configYaml({
      target: 'kubernetes',
      auditPath: posixPath(join(dir, 'audit.jsonl')),
      model:
        '    provider: anthropic\n    name: claude-sonnet-5-5\n    apiKey: ${env:ANTHROPIC_API_KEY}',
      approvers: ['@omar', 'console:omar'],
    });
    const path = await writeConfig(text, dir);
    const self = fakeSelfKubernetes();
    const stop = new AbortController();
    let port = 0;
    const t = testContext({
      env: {
        ANTHROPIC_API_KEY: 'k',
        KODRA_CONSOLE_TOKEN: 'run-k8s-shared-token-7b6a', // gitleaks:allow
        KODRA_CONSOLE_TOKEN_OMAR: OMAR,
        KODRA_AGENT_NAMESPACE: 'ops',
        KODRA_AGENT_CONFIGMAP: 'agent',
        KODRA_AGENT_DEPLOYMENT: 'agent',
        KODRA_AGENT_SECRET: 'agent-env',
        KODRA_AGENT_SETTINGS_DIR: join(dir, 'settings'),
      },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      selfKubernetes: () => self.client,
      stopSignal: stop.signal,
      healthPort: 0,
      consolePort: 0,
      consoleStaticDir: join(dir, 'no-build'),
      onReady: (info) => {
        port = info.consolePort ?? 0;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (port ? true : undefined));
    const base = `http://127.0.0.1:${String(port)}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: OMAR }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const post = (route: string, body: unknown) =>
      fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
        body: JSON.stringify(body),
      });
    const view = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as {
      base: string;
      editable: boolean;
    };
    expect(view.editable).toBe(true);
    const patch = { limits: { monthlyBudgetUsd: 25 } };
    expect((await post('settings/apply', { patch, base: view.base })).status).toBe(200);
    await until(() => (self.state.restartedAt.length > 0 ? true : undefined));
    expect(self.state.configMap['kodra-agent.yaml']).toContain('monthlyBudgetUsd: 25');
    expect(self.state.calls).toContain('patch deployment ops/agent');

    const added = await post('people/add', { name: 'on-call' });
    const { token } = (await added.json()) as { token: string };
    expect(self.state.secret['KODRA_CONSOLE_TOKEN_ON_CALL']).toBe(token);
    // The file on disk is not where a Kubernetes agent keeps its settings.
    expect(await readFile(path, 'utf8')).toBe(text);

    // The pod keeps running until Kubernetes stops it.
    stop.abort();
    expect(await running).toBe(0);
    expect(t.output()).toContain('Restarting the Deployment to apply the new settings.');
    expect(t.output()).not.toContain(token);
  });

  it('adds a console approver: the token comes back once, then it restarts', async () => {
    const SHARED = 'run-people-shared-token-8a7b'; // gitleaks:allow
    const OMAR = 'run-people-omar-token-1f2e'; // gitleaks:allow
    const dir = await tempDir();
    const auditPath = join(dir, 'audit.jsonl');
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(auditPath),
        model:
          '    provider: anthropic\n    name: claude-sonnet-5-5\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        approvers: ['@omar', 'console:omar'],
      }),
      dir,
    );
    const stop = new AbortController();
    let port = 0;
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k', KODRA_CONSOLE_TOKEN: SHARED, KODRA_CONSOLE_TOKEN_OMAR: OMAR },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      stopSignal: stop.signal,
      healthPort: 0,
      consolePort: 0,
      consoleStaticDir: join(dir, 'no-build'),
      onReady: (info) => {
        port = info.consolePort ?? 0;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (port ? true : undefined));
    const base = `http://127.0.0.1:${String(port)}`;
    const signIn = async (token: string) =>
      (
        (
          await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
        ).headers.get('set-cookie') ?? ''
      ).split(';')[0] ?? '';
    const post = (cookie: string, route: string, body: unknown) =>
      fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
        body: JSON.stringify(body),
      });

    const team = await signIn(SHARED);
    expect((await fetch(`${base}/api/people`, { headers: { cookie: team } })).status).toBe(403);
    expect((await post(team, 'people/add', { name: 'on-call' })).status).toBe(403);

    const omar = await signIn(OMAR);
    const view = (await (
      await fetch(`${base}/api/people`, { headers: { cookie: omar } })
    ).json()) as { sessions: { user: string }[] };
    expect(view.sessions.map((s) => s.user).sort()).toEqual(['console', 'console:omar']);
    const added = await post(omar, 'people/add', { name: 'on-call' });
    expect(added.status).toBe(200);
    const { token, restarting } = (await added.json()) as { token: string; restarting: boolean };
    expect(restarting).toBe(true);
    expect(await running).toBe(75);
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain(
      `KODRA_CONSOLE_TOKEN_ON_CALL=${token}`,
    );
    expect(t.output()).not.toContain(token);
    expect(await readFile(auditPath, 'utf8')).not.toContain(token);
  });

  it('serves the console: token sign-in, then status and connectors, read-only', async () => {
    const CONSOLE_TOKEN = 'run-console-token-canary-91b2'; // gitleaks:allow
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model:
          '    provider: anthropic\n    name: claude-sonnet-5-5\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: '    kubernetes:\n      enabled: true\n      config: {namespaces: [payments]}',
      }),
      dir,
    );
    const stop = new AbortController();
    let consolePort = 0;
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k', KODRA_CONSOLE_TOKEN: CONSOLE_TOKEN },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      stopSignal: stop.signal,
      healthPort: 0,
      consolePort: 0,
      consoleStaticDir: join(dir, 'no-build'),
      onReady: (info) => {
        consolePort = info.consolePort ?? 0;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (consolePort ? true : undefined));
    const base = `http://127.0.0.1:${String(consolePort)}`;

    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: CONSOLE_TOKEN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const get = async (route: string): Promise<unknown> =>
      (await fetch(`${base}/api/${route}`, { headers: { cookie } })).json();

    expect(await get('status')).toMatchObject({
      model: 'anthropic/claude-sonnet-5-5',
      target: 'compose',
      slack: false,
      connectors: [{ id: 'kubernetes', available: true }],
    });
    expect(await get('connectors')).toEqual([
      expect.objectContaining({
        id: 'kubernetes',
        access: 'read-only',
        tools: [
          {
            name: 'pods_log',
            risk: 'read',
            limits: ['namespace is required and must be one of: payments'],
          },
        ],
      }),
    ]);
    expect(await get('usage')).toMatchObject({
      model: 'anthropic/claude-sonnet-5-5',
      pricing: { asOf: '2026-09-25' },
    });

    stop.abort();
    expect(await running).toBe(0);
    expect(t.output()).toContain('Console on port');
    expect(t.output()).not.toContain(CONSOLE_TOKEN);
  });

  it('chats in the console and takes a console approval, closing the Slack request too', async () => {
    const SHARED = 'run-console-shared-token-5c3a'; // gitleaks:allow
    const OMAR = 'run-console-omar-token-8e1f'; // gitleaks:allow
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        approvers: ['@omar', 'console:omar'],
        connectors: [
          '    kubernetes:',
          '      enabled: true',
          '      access: read-write-approved',
          '      config: {namespaces: [payments]}',
          '    slack:',
          '      enabled: true',
          "      config: {channel: '#ops'}",
          "      secrets: {botToken: '${env:B}', appToken: '${env:A}'}",
        ].join('\n'),
      }),
      dir,
    );
    const slack = fakeSlack([{ id: 'U01OMAR', name: 'omar', displayName: 'Omar' }]);
    const stop = new AbortController();
    let consolePort = 0;
    const t = testContext({
      env: {
        ANTHROPIC_API_KEY: 'k',
        B: 'xoxb-1',
        A: 'xapp-1',
        KODRA_CONSOLE_TOKEN: SHARED,
        KODRA_CONSOLE_TOKEN_OMAR: OMAR,
      },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      slackConnection: () => slack.connection(),
      stopSignal: stop.signal,
      healthPort: 0,
      consolePort: 0,
      consoleStaticDir: join(dir, 'no-build'),
      onReady: (info) => {
        consolePort = info.consolePort ?? 0;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (consolePort ? true : undefined));
    const base = `http://127.0.0.1:${String(consolePort)}`;
    const signIn = async (token: string) => {
      const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    const post = (cookie: string, route: string, body: unknown) =>
      fetch(`${base}/api/${route}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
        body: JSON.stringify(body),
      });

    const team = await signIn(SHARED);
    const sent = await post(team, 'chat', { text: 'scale web to 2' });
    expect(sent.status).toBe(200);
    const { conversation } = (await sent.json()) as { conversation: string };

    // Live events, as the browser reads them.
    const stream = await fetch(`${base}/api/chat/events?conversation=${conversation}`, {
      headers: { cookie: team },
    });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += new TextDecoder().decode(value);
      }
    };
    await readUntil('"type":"approval"');
    // The request went to Slack's channel as well.
    await until(() =>
      slack.posted.some((m) => m.text.includes('needs approval')) ? true : undefined,
    );

    const pending = (await (
      await fetch(`${base}/api/approvals/pending`, { headers: { cookie: team } })
    ).json()) as { id: string }[];
    expect(pending).toHaveLength(1);
    const id = pending[0]?.id ?? '';
    // The shared token cannot approve; omar's own token can.
    expect((await post(team, 'approvals/decide', { id, approve: true })).status).toBe(403);
    const omar = await signIn(OMAR);
    expect((await post(omar, 'approvals/decide', { id, approve: true })).status).toBe(200);

    await readUntil('"type":"answer"');
    expect(text).toContain('Scaled web to 2.');
    expect(text).toContain('"by":"console:omar"');
    expect(slack.updated.at(-1)?.text).toContain('approved by console:omar in the console');
    await reader.cancel();

    stop.abort();
    expect(await running).toBe(0);
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"actor":"console:omar"');
    expect(audit).toContain('click refused: not an approver');
    for (const secret of [SHARED, OMAR]) {
      expect(t.output()).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });

  it('refuses direct messages from people who are not approvers', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors:
          "    slack:\n      enabled: true\n      config: {channel: '#ops'}\n      secrets: {botToken: '${env:B}', appToken: '${env:A}'}",
      }),
      dir,
    );
    const slack = fakeSlack();
    const stop = new AbortController();
    let ready = false;
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k', B: 'xoxb-1', A: 'xapp-1' },
      modelFactory: () => scriptedModel(),
      launcher: fakeLauncher(),
      slackConnection: () => slack.connection(),
      stopSignal: stop.signal,
      healthPort: 0,
      onReady: () => {
        ready = true;
      },
    });
    const running = main(['run', '--config', path], t.ctx);
    await until(() => (ready ? true : undefined));
    // '@omar' in the config matches no Slack user here, so nobody is an approver.
    expect(t.term.stderr.join('\n')).toContain('Approver @omar matches no single Slack user');
    await slack.handlers.onDirectMessage({
      user: 'U0STRANGER',
      channel: 'D0DM',
      text: 'scale web',
      ts: '1.1',
      channelType: 'im',
    });
    expect(slack.posted.at(-1)?.text).toContain('I only take direct messages from the approvers');
    stop.abort();
    expect(await running).toBe(0);
  });
});
