import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { fakeLauncher } from '../test-fixtures/fake-connector.ts';
import {
  configYaml,
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
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const prompt = JSON.stringify(options.prompt);
      const toolTurns = options.prompt.filter((m) => m.role === 'tool').length;
      if (prompt.includes('A monitoring alert is firing')) {
        if (toolTurns === 0)
          return Promise.resolve(
            call('kubernetes__pods_log', { namespace: 'payments', name: 'web-1' }),
          );
        if (toolTurns === 1) {
          return Promise.resolve(
            call('kubernetes__resources_scale', {
              namespace: 'payments',
              name: 'web',
              scale: 0,
              kodra_reason: 'stop it',
            }),
          );
        }
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
    },
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
      const investigationPrompt = JSON.stringify(model.doGenerateCalls.map((c) => c.prompt));
      expect(investigationPrompt).toContain('investigations are read-only');

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
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          tool: 'resources_scale',
          decision: 'blocked',
          actor: 'monitor',
        }),
      );

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
    expect(hello).toMatch(/• Kubernetes: read-only, \d+ tools/);

    stop.abort();
    expect(await running).toBe(0);
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
