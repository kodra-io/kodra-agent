import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './cli.ts';
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
} from './test-helpers.ts';

/**
 * SPEC section 11: "Tests prove that a secret value never appears in logs, the audit log,
 * or model payloads." Known canary values go through init and doctor, including failing
 * checks, and every byte of output is searched for them. Model payloads join in M4.
 */
const CANARIES = {
  anthropic: 'canary-anthropic-7f3a9b2c',
  github: 'canary-github-4e8d1a6f',
  slackBot: 'canary-slackbot-2b9c7e1d',
  slackApp: 'canary-slackapp-9a1f3c5e',
  kubeconfig: 'apiVersion: v1\nusers:\n- user:\n    token: canary-kube-6d2e8b4a\n', // gitleaks:allow (canary, fake)
};

const ALL = [
  ...Object.values(CANARIES),
  'canary-kube-6d2e8b4a',
  Buffer.from(CANARIES.github).toString('base64'),
  encodeURIComponent(CANARIES.kubeconfig),
];

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('secret canary', () => {
  it('never shows up in output, logs, errors, or the audit log', async () => {
    server = await fakeServer({
      // Hostile servers echo the credentials back; the agent must still not print them.
      '/v1/models': (req, res) => {
        json(res, 401, { error: `bad key ${String(req.headers['x-api-key'])}` });
      },
      '/repos/acme/api': (req, res) => {
        json(res, 200, { echoed: req.headers.authorization });
      },
      'POST /api/auth.test': (_req, res) => {
        json(res, 200, { ok: true });
      },
      'POST /api/apps.connections.open': (req, res) => {
        json(res, 200, { ok: false, error: `invalid_auth ${String(req.headers.authorization)}` });
      },
    });
    const dir = await tempDir();
    const auditPath = join(dir, 'audit', 'audit.jsonl');
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(auditPath),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: [
          '    github:',
          '      enabled: true',
          '      config: {repos: [acme/api]}',
          "      secrets: {token: '${env:GITHUB_TOKEN}'}",
          '    slack:',
          '      enabled: true',
          "      config: {channel: '#ops'}",
          "      secrets: {botToken: '${env:SLACK_BOT_TOKEN}', appToken: '${env:SLACK_APP_TOKEN}'}",
          '    kubernetes:',
          '      enabled: true',
          '      config: {namespaces: [api]}',
          "      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
        ].join('\n'),
      }),
      dir,
    );
    await writeFile(join(dir, 'kc-source'), CANARIES.kubeconfig);

    const k8s = fakeKubernetes({
      listPods: () =>
        Promise.reject(
          Object.assign(new Error(`denied for ${CANARIES.kubeconfig}`), { code: 401 }),
        ),
    });
    const endpoints = { anthropic: server.url, github: server.url, slack: server.url };

    // init (components in manifest order): the model key, kubeconfig, and Slack app token
    // fail their checks and are kept anyway.
    const first = testContext({
      kubernetes: k8s,
      endpoints,
      prompter: scriptedPrompter([
        CANARIES.anthropic,
        'keep',
        CANARIES.github,
        'kc-source',
        'keep',
        CANARIES.slackBot,
        CANARIES.slackApp,
        'keep',
      ]),
    });
    expect(await main(['init', '--config', path], first.ctx)).toBe(0);

    // doctor: a fresh process that only sees the stored .env and secrets file.
    const second = testContext({ kubernetes: k8s, endpoints });
    const kubeconfigPath = join(dir, 'secrets', 'kubeconfig');
    const configForDoctor = (await readFile(path, 'utf8')).replace(
      '${file:/secrets/kubeconfig}',
      `\${file:${posixPath(kubeconfigPath)}}`,
    );
    await writeFile(path, configForDoctor);
    expect(await main(['doctor', '--config', path], second.ctx)).toBe(1);
    const third = testContext({ kubernetes: k8s, endpoints });
    await main(['doctor', '--json', '--config', path], third.ctx);

    const everything = [
      first.output(),
      first.logLines.join('\n'),
      second.output(),
      second.logLines.join('\n'),
      third.output(),
      await readFile(auditPath, 'utf8'),
    ].join('\n');

    for (const canary of ALL) {
      expect(everything.includes(canary), `leaked: ${canary.slice(0, 16)}…`).toBe(false);
    }
    // The stored values are where they belong, so the test did exercise them.
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain(CANARIES.github);
    expect(await readFile(kubeconfigPath, 'utf8')).toContain('canary-kube-6d2e8b4a');
    expect(second.output()).toContain('FAIL');
  });
});
