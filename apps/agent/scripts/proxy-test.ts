import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * pnpm test:proxy (PLAN-v0.2 M12): the agent image on a network whose only way out is a
 * TLS-inspecting proxy (mitmproxy) with its own CA. Every outside service is a stand-in
 * reachable only through the proxy, so a client that ignores the proxy, or does not trust the
 * extra CA, fails. Checks: doctor passes (Node fetch, Slack probes); `run` connects to Slack
 * (Web API and the Socket Mode WebSocket), and an alert gets an investigation whose model calls
 * a Python MCP server (Prometheus) and a Go one (Grafana); git and helm, which ship runs, get
 * through too; and the proxy's password never appears in the agent's output.
 */
const IMAGE = process.env['KODRA_IMAGE'] ?? 'ghcr.io/kodra-io/kodra-agent:ci';
const MITMPROXY =
  'mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f';
const NODE = 'node:24.21.0-trixie-slim';
const PROXY_PASSWORD = 'proxy-pass-7c1e9b'; // gitleaks:allow (a throwaway test value)
const HOSTS = [
  'slack.com',
  'slack-ws.test',
  'model.test',
  'alertmanager.test',
  'prometheus.test',
  'grafana.test',
  'git.test',
  'charts.test',
];
const NAME = 'kodra-px';
const scripts = fileURLToPath(new URL('.', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'kodra-proxy-'));

function docker(args: string[], opts: { check?: boolean } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (opts.check !== false && result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${result.stderr}`);
  }
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, check: () => T | null, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

interface Seen {
  seen: string[];
  posted: string[];
}
const seen = (): Seen | null => {
  const r = docker(
    [
      'exec',
      `${NAME}-stub`,
      'node',
      '-e',
      "fetch('http://127.0.0.1:8099').then((r) => r.text()).then((t) => process.stdout.write(t))",
    ],
    { check: false },
  );
  try {
    return JSON.parse(r.stdout) as Seen;
  } catch {
    return null;
  }
};

function cleanup() {
  for (const c of ['agent', 'proxy', 'stub'])
    docker(['rm', '-f', `${NAME}-${c}`], { check: false });
  for (const n of ['in', 'out']) docker(['network', 'rm', `${NAME}-${n}`], { check: false });
}

async function main() {
  cleanup();
  // The stand-ins' certificate: mitmproxy checks nothing upstream (ssl_insecure), so any will do.
  const stubDir = join(work, 'stub');
  mkdirSync(stubDir);
  const openssl = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=stub',
      '-keyout',
      join(stubDir, 'key.pem'),
      '-out',
      join(stubDir, 'cert.pem'),
      '-addext',
      `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`,
    ],
    { encoding: 'utf8' },
  );
  if (openssl.status !== 0) throw new Error(`openssl failed: ${openssl.stderr}`);

  docker(['network', 'create', `${NAME}-out`]);
  // The agent's network has no way out: no gateway, only the proxy.
  docker(['network', 'create', '--internal', `${NAME}-in`]);
  docker([
    'run',
    '-d',
    '--name',
    `${NAME}-stub`,
    '--network',
    `${NAME}-out`,
    ...HOSTS.flatMap((h) => ['--network-alias', h]),
    '-v',
    `${stubDir}:/stub:ro`,
    '-v',
    `${join(scripts, 'proxy-stub.mjs')}:/app/stub.mjs:ro`,
    NODE,
    'node',
    '/app/stub.mjs',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    `${NAME}-proxy`,
    '--network',
    `${NAME}-out`,
    MITMPROXY,
    'mitmdump',
    '--listen-port',
    '8080',
    '--set',
    'ssl_insecure=true',
    '--set',
    `proxyauth=kodra:${PROXY_PASSWORD}`,
  ]);
  docker(['network', 'connect', '--alias', 'proxy.test', `${NAME}-in`, `${NAME}-proxy`]);

  // The proxy's CA, which the agent must trust for every TLS connection.
  const bundle = join(work, 'bundle');
  mkdirSync(join(bundle, 'ca'), { recursive: true });
  await until(
    "mitmproxy's CA",
    () =>
      docker(
        [
          'cp',
          `${NAME}-proxy:/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem`,
          join(bundle, 'ca', 'ca.pem'),
        ],
        { check: false },
      ).status === 0
        ? true
        : null,
    60_000,
  );
  writeFileSync(
    join(bundle, 'kodra-agent.yaml'),
    `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: proxy-test
spec:
  target: compose
  model:
    provider: anthropic
    name: stub-model
    apiKey: \${env:ANTHROPIC_API_KEY}
    baseUrl: https://model.test
  connectors:
    prometheus:
      enabled: true
      config:
        url: https://prometheus.test
        alertmanagerUrl: https://alertmanager.test
        pollIntervalSeconds: 15
    grafana:
      enabled: true
      config:
        url: https://grafana.test
      secrets:
        serviceAccountToken: \${env:GRAFANA_TOKEN}
    slack:
      enabled: true
      config:
        channel: '#ops'
      secrets:
        botToken: \${env:SLACK_BOT_TOKEN}
        appToken: \${env:SLACK_APP_TOKEN}
  policy:
    approvals:
      approvers: ['U0OPS']
  network:
    proxy:
      https: \${env:HTTPS_PROXY}
    caBundleFile: /etc/kodra-agent/ca/ca.pem
  console:
    enabled: false
  audit:
    path: /tmp/audit/audit.jsonl
`,
  );
  const env = [
    `HTTPS_PROXY=http://kodra:${PROXY_PASSWORD}@proxy.test:8080`,
    'ANTHROPIC_API_KEY=stub-key',
    'GRAFANA_TOKEN=stub-grafana-token',
    'SLACK_BOT_TOKEN=xoxb-stub',
    'SLACK_APP_TOKEN=xapp-stub',
  ].flatMap((e) => ['-e', e]);
  const run = (...args: string[]) => [
    'run',
    '--network',
    `${NAME}-in`,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '-v',
    `${bundle}:/etc/kodra-agent:ro`,
    ...env,
    ...args,
  ];

  // 1. doctor: Node fetch to the model, Slack's two token checks, Grafana's.
  const doctor = docker(run('--rm', IMAGE, 'doctor', '--json'), { check: false });
  process.stdout.write(doctor.stdout);
  if (doctor.status !== 0) throw new Error(`doctor failed behind the proxy:\n${doctor.stderr}`);
  console.log('proxy: doctor passed through the proxy');

  // 2. run: Slack connects, the alert is investigated with a Python and a Go MCP server.
  docker(run('-d', '--name', `${NAME}-agent`, IMAGE, 'run'));
  const result = await until(
    'the investigation to be posted in Slack',
    () => {
      const s = seen();
      return s?.posted.some((p) => p.includes('Proxy check: the alert is a test')) ? s : null;
    },
    240_000,
  );
  const logs = docker(['logs', `${NAME}-agent`], { check: false });
  const output = `${logs.stdout}${logs.stderr}`;
  if (output.includes(PROXY_PASSWORD))
    throw new Error("the proxy's password reached the agent's output");

  // 3. git and helm, as ship runs them.
  const check = docker(
    run(
      '--rm',
      '-v',
      `${join(scripts, 'proxy-check.ts')}:/app/apps/agent/scripts/proxy-check.ts:ro`,
      '--entrypoint',
      'node',
      IMAGE,
      '--disable-warning=ExperimentalWarning',
      '/app/apps/agent/scripts/proxy-check.ts',
    ),
    { check: false },
  );
  process.stdout.write(check.stdout);
  if (check.status !== 0) throw new Error(`git or helm failed behind the proxy:\n${check.stderr}`);

  const final = seen() ?? result;
  const expected = [
    'slack.com POST /api/auth.test',
    'slack.com POST /api/apps.connections.open',
    'slack.com POST /api/chat.postMessage',
    'slack-ws.test UPGRADE /link',
    'model.test POST /v1/messages',
    'alertmanager.test GET /api/v2/alerts',
    'prometheus.test GET /api/v1/query',
    'grafana.test GET /api/search',
    'git.test GET /repo.git/info/refs',
    'charts.test GET /index.yaml',
  ];
  const missing = expected.filter((e) => !final.seen.includes(e));
  if (missing.length > 0) {
    throw new Error(
      `these never reached their stand-in:\n${missing.join('\n')}\nseen:\n${final.seen.join('\n')}`,
    );
  }
  console.log('proxy: every client reached its stand-in through the proxy, with its CA');
}

try {
  await main();
  console.log('\nProxy test passed.');
} catch (error) {
  for (const c of ['agent', 'proxy', 'stub']) {
    const logs = docker(['logs', '--tail', '80', `${NAME}-${c}`], { check: false });
    console.error(`--- ${c} ---\n${logs.stdout}${logs.stderr}`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanup();
}
