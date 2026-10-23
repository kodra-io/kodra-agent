import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const KUBE_TOKEN = 'canary-check-kube-token-7d2a91fe';
const PODS = new URL('../test-fixtures/dashboard/', import.meta.url);

let servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/**
 * Kubernetes through the fake MCP server (its pods come from a file the test swaps), a
 * fake Alertmanager, and optionally Slack.
 */
async function setup(opts: { slack?: boolean } = {}) {
  const dir = await tempDir();
  const podsFile = join(dir, 'pods.txt');
  await copyFile(new URL('kubernetes-pods.txt', PODS), podsFile);
  let alerts: unknown[] = [
    {
      fingerprint: 'fp-disk',
      labels: { alertname: 'DiskFilling', severity: 'warning', namespace: 'dev' },
      annotations: { summary: 'data volume at 91%' },
      startsAt: '2026-10-22T04:00:00Z',
    },
  ];
  const alertmanager = await fakeServer({
    '/api/v2/alerts': (_q, s) => {
      json(s, 200, alerts);
    },
  });
  servers.push(alertmanager);
  const kubeconfig = join(dir, 'kubeconfig');
  await writeFile(kubeconfig, `apiVersion: v1\nusers:\n- user:\n    token: ${KUBE_TOKEN}\n`);
  const auditPath = join(dir, 'audit', 'audit.jsonl');
  const path = await writeConfig(
    configYaml({
      auditPath: posixPath(auditPath),
      connectors: [
        '    kubernetes:',
        '      enabled: true',
        '      access: read-only',
        '      config: {namespaces: [dev]}',
        `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfig)}}'}`,
        '    prometheus:',
        '      enabled: true',
        `      config: {url: 'http://127.0.0.1:1', alertmanagerUrl: '${alertmanager.url}'}`,
        ...(opts.slack
          ? [
              '    slack:',
              '      enabled: true',
              "      config: {channel: '#ops'}",
              "      secrets: {botToken: '${env:SLACK_BOT_TOKEN}', appToken: '${env:SLACK_APP_TOKEN}'}",
            ]
          : []),
      ].join('\n'),
    }),
    dir,
  );
  const slack = fakeSlack();
  const context = () =>
    testContext({
      env: { SLACK_BOT_TOKEN: 'xoxb-check-test', SLACK_APP_TOKEN: 'xapp-check-test' },
      launcher: fakeLauncher({ pods: podsFile }),
      slackConnection: () => slack.connection(),
      checksNow: () => new Date('2026-10-22T05:30:00Z'),
    });
  return {
    dir,
    path,
    auditPath,
    slack,
    context,
    fixPods: () => copyFile(new URL('kubernetes-pods-empty.txt', PODS), podsFile),
    clearAlerts: () => {
      alerts = [];
    },
  };
}

describe('kodra-agent check', () => {
  it(
    'prints the digest without saving it, and exits 1 while something is broken',
    { timeout: 60_000 },
    async () => {
      const s = await setup();
      const t = s.context();
      expect(await main(['check', '--config', s.path], t.ctx)).toBe(1);
      const out = t.output();
      expect(out).toContain('*Checks* (run from the command line, 2026-10-22 05:30 UTC): 3 new');
      expect(out).toContain('• [critical] Pod broken-b4c5b6f66-kvwxv is Error (6 restarts) (dev)');
      expect(out).toContain('• DiskFilling: data volume at 91% (dev)');
      expect(out).toContain('Checked: pods, alerts, the agent.');
      expect(out).toMatch(/Audit log head: #\d+ [0-9a-f]{16}\./);
      // A dry run saves nothing, so the next digest still calls these new.
      await expect(readFile(join(s.dir, 'audit', 'checks.json'), 'utf8')).rejects.toThrow();
    },
  );

  it('posts to Slack with --post, then reports what was fixed', { timeout: 60_000 }, async () => {
    const s = await setup({ slack: true });
    expect(await main(['check', '--post', '--config', s.path], s.context().ctx)).toBe(1);
    expect(s.slack.posted).toHaveLength(1);
    expect(s.slack.posted[0]?.text).toContain('3 new, 0 still broken, 0 fixed.');

    await s.fixPods();
    s.clearAlerts();
    const t = s.context();
    expect(await main(['check', '--post', '--config', s.path], t.ctx)).toBe(0);
    expect(s.slack.posted[1]?.text).toContain(
      'everything checked is fine, and 3 problems fixed since last time.',
    );
    expect(s.slack.posted[1]?.text).toContain('*Fixed since last time*');

    // The connector's credentials never reach the digest, Slack, or the audit log.
    const everything = [
      t.output(),
      ...s.slack.posted.map((p) => p.text),
      await readFile(s.auditPath, 'utf8'),
      await readFile(join(s.dir, 'audit', 'checks.json'), 'utf8'),
    ].join('\n');
    expect(everything).not.toContain(KUBE_TOKEN);
    // Only read tools ran: no approval was asked, nothing was blocked.
    const audit = await readFile(s.auditPath, 'utf8');
    expect(audit).not.toContain('approval.request');
    expect(audit).toContain('"actor":"checks"');
  });

  it('refuses --post without Slack', { timeout: 60_000 }, async () => {
    const s = await setup();
    const t = s.context();
    expect(await main(['check', '--post', '--config', s.path], t.ctx)).toBe(2);
    expect(t.output()).toContain('--post needs the Slack connector');
  });
});
