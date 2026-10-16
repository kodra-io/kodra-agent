import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import {
  AGENT_IMAGE,
  AGENT_VERSION,
  connectorDefaults,
  emptyDraft,
  generateBundle,
  modelFieldDefaults,
  type AgentDraft,
} from '@kodra-agent/templates';
import { getConnector } from '@kodra-agent/connectors';

/**
 * pnpm test:package: the M7 checks on a built agent image (KODRA_IMAGE, default the
 * bundle's image), following the bundle README:
 *   1. every preinstalled MCP server starts offline on a read-only root filesystem;
 *   2. a generated compose bundle runs `init --non-interactive` and `up`, and the agent
 *      answers /healthz and /readyz; a console approver changes a setting, and Compose
 *      restarts the agent with it;
 *   3. on a throwaway kind cluster, the chart installs with the bundle's values.yaml and
 *      the pod becomes ready; a console approver changes a setting, the agent saves it in its
 *      settings ConfigMap and restarts its Deployment, a helm upgrade with the same config keeps
 *      it, and one with a changed config wins (skip with
 *      --no-kind).
 * The kind kubeconfig goes to a temporary file: the user's kube context is never changed.
 */
const IMAGE = process.env['KODRA_IMAGE'] ?? `${AGENT_IMAGE}:${AGENT_VERSION}`;
const KIND = process.env['KIND'] ?? 'kind';
const CLUSTER = 'kodra-agent-package';
const NAME = 'package-test';
const SAMPLE = fileURLToPath(new URL('../../../examples/ship/go', import.meta.url));
const CHART = fileURLToPath(new URL('../../../charts/kodra-agent', import.meta.url));
// promtool for the chart's alert rules: prom/prometheus v3.15.0.
const PROMETHEUS =
  'prom/prometheus@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e';
const base =
  process.platform === 'win32'
    ? join(process.cwd(), 'node_modules', '.cache', 'kodra-package')
    : tmpdir();
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, 'kodra-package-'));

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...(cwd ? { cwd } : {}),
  });
}

/** Runs with output shown, and fails on a non-zero exit. */
function show(cmd: string, args: string[], cwd?: string): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} exited ${String(result.status)}`);
}

function draft(
  target: AgentDraft['target'],
  connectors: AgentDraft['connectors'] = {},
  approvers = 'U0OPS',
): AgentDraft {
  return {
    ...emptyDraft(),
    connectors,
    name: NAME,
    target,
    model: {
      provider: 'ollama',
      name: 'llama3',
      // Never called: these checks start the agent, not a conversation.
      fields: { ...modelFieldDefaults('ollama'), baseUrl: 'http://127.0.0.1:11434' },
    },
    policy: { approvers, expiresAfterMinutes: '15', destructiveActions: 'deny' },
  };
}

function writeBundle(
  target: AgentDraft['target'],
  folder: string = target,
  connectors: AgentDraft['connectors'] = {},
  approvers?: string,
): string {
  const dir = join(work, folder);
  for (const file of generateBundle(draft(target, connectors, approvers)).files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content.replaceAll(`${AGENT_IMAGE}:${AGENT_VERSION}`, IMAGE));
  }
  return dir;
}

async function until(what: string, check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The image's `aws eks get-token`, for EKS kubeconfigs: signing needs no network. */
function eksToken(): void {
  console.log('\n== aws eks get-token in the image, offline');
  const aws = (...args: string[]) =>
    spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--network',
        'none',
        '-e',
        'AWS_ACCESS_KEY_ID=AKIDEXAMPLE',
        '-e',
        'AWS_SECRET_ACCESS_KEY=not-a-real-secret',
        '--entrypoint',
        'aws',
        IMAGE,
        ...args,
      ],
      { encoding: 'utf8' },
    );
  const ok = aws(
    '--region',
    'us-east-1',
    'eks',
    'get-token',
    '--cluster-name',
    'demo',
    '--output',
    'json',
  );
  if (ok.status !== 0) throw new Error(`aws eks get-token failed: ${ok.stderr}`);
  const cred = JSON.parse(ok.stdout) as { kind?: string; status?: { token?: string } };
  if (cred.kind !== 'ExecCredential' || !cred.status?.token?.startsWith('k8s-aws-v1.')) {
    throw new Error(`unexpected ExecCredential: ${ok.stdout}`);
  }
  if (aws('s3', 'ls').status !== 2) throw new Error('aws s3 ls should be refused');
  console.log(
    'aws eks get-token: an ExecCredential with a k8s-aws-v1 token; other commands refused',
  );
}

function servers(): void {
  console.log('\n== Preinstalled MCP servers, offline, read-only root filesystem');
  show('docker', [
    'run',
    '--rm',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--network',
    'none',
    '--entrypoint',
    'node',
    IMAGE,
    '--disable-warning=ExperimentalWarning',
    '/app/apps/agent/scripts/check-servers.ts',
  ]);
}

async function compose(): Promise<void> {
  console.log('\n== Compose bundle: init, up, health');
  const dir = writeBundle('compose', 'compose', {}, 'U0OPS, console:ops');
  writeFileSync(join(dir, '.env'), linuxEnv(false));
  const dc = (...args: string[]) => {
    show('docker', ['compose', ...args], dir);
  };
  try {
    dc('run', '--rm', '-T', 'kodra-agent', 'init', '--non-interactive');
    // init writes .env and secrets/ into the bundle folder: the container must be able to.
    dc(
      'run',
      '--rm',
      '-T',
      '--entrypoint',
      'node',
      'kodra-agent',
      '-e',
      "require('node:fs').writeFileSync('/etc/kodra-agent/.write-test', 'ok')",
    );
    if (!existsSync(join(dir, '.write-test')))
      throw new Error('the agent cannot write to the bundle folder');
    dc('up', '-d');
    const probe = (path: string) =>
      spawnSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'kodra-agent',
          'node',
          '-e',
          `fetch('http://127.0.0.1:8080${path}').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
        ],
        { cwd: dir, stdio: 'ignore' },
      ).status === 0;
    await until('/healthz in compose', () => probe('/healthz'), 90_000);
    await until('/readyz in compose', () => probe('/readyz'), 30_000);
    console.log('compose: /healthz and /readyz answer');
    await consoleCheck(dir);
    await consoleSettingsOnCompose(dir);
  } catch (error) {
    spawnSync('docker', ['compose', 'logs', '--no-color'], { cwd: dir, stdio: 'inherit' });
    throw error;
  } finally {
    spawnSync('docker', ['compose', 'down', '-v'], { cwd: dir, stdio: 'inherit' });
  }
}

/**
 * The console from the bundle README: http://localhost:8081 on this machine, signed in with
 * KODRA_CONSOLE_TOKEN from the .env that init wrote.
 */
async function consoleCheck(dir: string): Promise<void> {
  const env = readFileSync(join(dir, '.env'), 'utf8');
  const token = /^KODRA_CONSOLE_TOKEN=(.+)$/m.exec(env)?.[1]?.trim();
  if (!token) throw new Error('init did not create KODRA_CONSOLE_TOKEN');
  const base = 'http://127.0.0.1:8081';
  await untilAsync(
    'the console page',
    async () => {
      const res = await fetch(`${base}/`).catch(() => null);
      return res?.status === 200 && (await res.text()).includes('<div id="root">');
    },
    60_000,
  );
  if ((await fetch(`${base}/api/status`)).status !== 401)
    throw new Error('the console API is open without a sign-in');
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (login.status !== 200) throw new Error(`console sign-in failed: HTTP ${String(login.status)}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const status = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()) as {
    version?: string;
  };
  if (!status.version) throw new Error('the console status has no version');

  // Writes (chat, approvals) need the session, this origin, and the console's header.
  const write = (headers: Record<string, string>) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'hello' }),
    });
  const refused: [string, Record<string, string>, number][] = [
    ['without a session', { 'x-kodra-console': '1' }, 401],
    ['without the header', { cookie }, 403],
    [
      'from another origin',
      { cookie, 'x-kodra-console': '1', origin: 'https://evil.example' },
      403,
    ],
  ];
  for (const [what, headers, expected] of refused) {
    const res = await write(headers);
    if (res.status !== expected) {
      throw new Error(
        `a console write ${what} got HTTP ${String(res.status)}, not ${String(expected)}`,
      );
    }
  }
  const session = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as {
    user?: string;
    canApprove?: boolean;
  };
  if (session.user !== 'console' || session.canApprove !== false) {
    throw new Error('the shared console token must not be able to approve');
  }
  console.log(`console: signed in on ${base}, agent ${status.version}; writes are guarded`);
}

/**
 * Console settings on Compose: a console approver saves a setting, the agent writes
 * kodra-agent.yaml (keeping .previous) and exits 75, and Compose starts it again with it.
 */
async function consoleSettingsOnCompose(dir: string): Promise<void> {
  const env = readFileSync(join(dir, '.env'), 'utf8');
  const token = /^KODRA_CONSOLE_TOKEN_OPS=(.+)$/m.exec(env)?.[1]?.trim();
  if (!token) throw new Error('init did not create KODRA_CONSOLE_TOKEN_OPS');
  const base = 'http://127.0.0.1:8081';
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (login.status !== 200)
    throw new Error(`approver sign-in failed: HTTP ${String(login.status)}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const view = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as {
    editable?: boolean;
    base?: string;
  };
  if (view.editable !== true) throw new Error('settings are not editable on Compose');

  const container = sh('docker', ['compose', 'ps', '-q', 'kodra-agent'], dir).trim();
  const restarts = () =>
    Number(sh('docker', ['inspect', '-f', '{{.RestartCount}}', container]).trim());
  const before = restarts();
  const saved = await fetch(`${base}/api/settings/apply`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
    body: JSON.stringify({ patch: { limits: { monthlyBudgetUsd: 25 } }, base: view.base }),
  });
  if (saved.status !== 200) throw new Error(`saving settings: HTTP ${String(saved.status)}`);
  await until('Compose to restart the agent', () => restarts() > before, 60_000);

  const config = readFileSync(join(dir, 'kodra-agent.yaml'), 'utf8');
  if (!/monthlyBudgetUsd: 25\b/.test(config))
    throw new Error('kodra-agent.yaml does not have the saved budget');
  if (!existsSync(join(dir, 'kodra-agent.yaml.previous')))
    throw new Error('the save did not keep kodra-agent.yaml.previous');
  // The session is signed with the token, so it survives the restart.
  await untilAsync(
    'the console after the restart',
    async () => {
      const res = await fetch(`${base}/api/session`, { headers: { cookie } }).catch(() => null);
      return res?.ok === true && ((await res.json()) as { signedIn?: boolean }).signedIn === true;
    },
    60_000,
  );
  console.log('compose: a console setting was saved, Compose restarted the agent, still signed in');
}

async function untilAsync(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The README's Linux steps: run as the folder's owner, with the Docker socket's group. */
function linuxEnv(docker: boolean): string {
  if (!process.getuid || !process.getgid) return '';
  const lines = [`KODRA_AGENT_USER=${String(process.getuid())}:${String(process.getgid())}`];
  if (docker) {
    const gid = spawnSync('getent', ['group', 'docker'], { encoding: 'utf8' }).stdout.split(':')[2];
    if (gid) lines.push(`KODRA_DOCKER_GID=${gid.trim()}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `ship` in the bundle's one-shot kodra-builder container, the only one with the Docker socket. */
function shipInContainer(): void {
  console.log('\n== ship inside the kodra-builder container (Docker build access)');
  const docker = getConnector('docker');
  if (!docker) throw new Error('no Docker connector');
  const dir = writeBundle('compose', 'ship', {
    docker: { ...connectorDefaults(docker, 'compose'), access: 'read-write-approved' },
  });
  writeFileSync(join(dir, '.env'), linuxEnv(true));
  // A sample app inside the bundle folder, which the container sees at /etc/kodra-agent.
  cpSync(SAMPLE, join(dir, 'go-api'), { recursive: true });
  // The always-on service never has the socket (M14); the one-shot builder does.
  const config = JSON.parse(sh('docker', ['compose', 'config', '--format', 'json'], dir)) as {
    services: Record<string, { volumes?: { source?: string; target?: string }[] }>;
  };
  const mounts = (service: string) =>
    JSON.stringify(config.services[service]?.volumes ?? []).includes('/var/run/docker.sock');
  if (mounts('kodra-agent')) throw new Error('the always-on kodra-agent mounts the Docker socket');
  if (!mounts('kodra-builder')) throw new Error('kodra-builder does not mount the Docker socket');
  show(
    'docker',
    ['compose', 'run', '--rm', '-T', 'kodra-builder', 'ship', '/etc/kodra-agent/go-api'],
    dir,
  );
  for (const file of ['Dockerfile', '.dockerignore', 'charts/go-api/Chart.yaml']) {
    if (!existsSync(join(dir, 'go-api', file))) throw new Error(`ship did not write ${file}`);
  }
  const leftover = sh('docker', [
    'ps',
    '-a',
    '--filter',
    'name=kodra-ship-',
    '--format',
    '{{.Names}}',
  ]).trim();
  const networks = sh('docker', [
    'network',
    'ls',
    '--filter',
    'name=kodra-ship-',
    '--format',
    '{{.Name}}',
  ]).trim();
  if (leftover || networks)
    throw new Error(`ship left containers or networks behind: ${leftover} ${networks}`);
  console.log(
    'ship: built, started, and checked the app from kodra-builder; kodra-agent has no socket',
  );
  spawnSync('docker', ['compose', 'down', '-v'], { cwd: dir, stdio: 'inherit' });
}

async function kind(): Promise<void> {
  console.log('\n== Helm chart on kind, with the bundle values');
  const dir = writeBundle('kubernetes', 'kubernetes', {}, 'U0OPS, console:ops');
  const fullname = `${NAME}-kodra-agent`;
  // `init --target kubernetes` makes these; random here, and never printed.
  const shared = randomBytes(32).toString('base64url');
  const approver = randomBytes(32).toString('base64url');
  const kubeconfig = join(work, 'kubeconfig');
  const kubectl = Object.assign(
    (...args: string[]) => sh('kubectl', ['--kubeconfig', kubeconfig, ...args]),
    { kubeconfigArgs: ['--kubeconfig', kubeconfig] },
  );
  show(KIND, [
    'create',
    'cluster',
    '--name',
    CLUSTER,
    '--kubeconfig',
    kubeconfig,
    '--wait',
    '120s',
  ]);
  try {
    show(KIND, ['load', 'docker-image', IMAGE, '--name', CLUSTER]);
    kubectl('create', 'namespace', 'kodra-agent');
    // `init --target kubernetes` creates this Secret; this config has no secrets, so make it here.
    kubectl(
      '-n',
      'kodra-agent',
      'create',
      'secret',
      'generic',
      `${NAME}-secrets`,
      '--from-literal=KODRA_PACKAGE_TEST=1',
      `--from-literal=KODRA_CONSOLE_TOKEN=${shared}`,
      `--from-literal=KODRA_CONSOLE_TOKEN_OPS=${approver}`,
    );
    const [repository, tag] = [
      IMAGE.slice(0, IMAGE.lastIndexOf(':')),
      IMAGE.slice(IMAGE.lastIndexOf(':') + 1),
    ];
    const helm = (verb: 'install' | 'upgrade'): void => {
      show(
        'helm',
        [
          verb,
          NAME,
          CHART,
          '--kubeconfig',
          kubeconfig,
          '--namespace',
          'kodra-agent',
          // From the bundle folder, as in the README (--set-file reads backslashes as escapes).
          '-f',
          'values.yaml',
          '--set-file',
          'config=kodra-agent.yaml',
          '--set',
          `image.repository=${repository}`,
          '--set',
          `image.tag=${tag}`,
          '--set',
          'image.pullPolicy=Never',
          '--wait',
          '--timeout',
          '180s',
        ],
        dir,
      );
    };
    helm('install');
    const pod = JSON.parse(
      kubectl(
        '-n',
        'kodra-agent',
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/instance=${NAME}`,
        '-o',
        'json',
      ),
    ) as {
      items: {
        status: { containerStatuses?: { ready: boolean }[] };
        spec: { securityContext?: { runAsUser?: number } };
      }[];
    };
    const item = pod.items[0];
    if (!item?.status.containerStatuses?.every((c) => c.ready))
      throw new Error('the agent pod is not ready');
    if (item.spec.securityContext?.runAsUser !== 10001)
      throw new Error('the agent pod does not run as 10001');
    console.log('kind: the chart installed and the agent pod is ready, as uid 10001');
    // The agent's own metrics (M14), scraped through the metrics Service.
    const scrape = kubectl(
      'get',
      '--raw',
      `/api/v1/namespaces/kodra-agent/services/http:${fullname}-metrics:metrics/proxy/metrics`,
    );
    for (const want of ['kodra_agent_info{version="', 'kodra_agent_approvals_pending 0']) {
      if (!scrape.includes(want)) throw new Error(`/metrics lacks ${want}:\n${scrape}`);
    }
    console.log('kind: /metrics answers through the metrics Service');
    await consoleSettingsOnKind(kubectl, fullname, approver, (changed) => {
      // A changed config, as when someone edits kodra-agent.yaml and upgrades.
      if (changed)
        writeFileSync(
          join(dir, 'kodra-agent.yaml'),
          `${readFileSync(join(dir, 'kodra-agent.yaml'), 'utf8')}# changed
`,
        );
      helm('upgrade');
    });
  } catch (error) {
    spawnSync('kubectl', ['--kubeconfig', kubeconfig, '-n', 'kodra-agent', 'describe', 'pods'], {
      stdio: 'inherit',
    });
    spawnSync(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        'kodra-agent',
        'logs',
        '-l',
        `app.kubernetes.io/instance=${NAME}`,
        '--tail',
        '100',
      ],
      { stdio: 'inherit' },
    );
    throw error;
  } finally {
    spawnSync(KIND, ['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', kubeconfig], {
      stdio: 'inherit',
    });
  }
}

/**
 * Console settings on Kubernetes: the agent may patch only its own ConfigMap, Secret, and
 * Deployment; a saved setting reaches a new pod; a helm upgrade with the same config keeps it,
 * and one with a changed config wins.
 */
async function consoleSettingsOnKind(
  kubectl: ((...args: string[]) => string) & { kubeconfigArgs: string[] },
  fullname: string,
  token: string,
  upgrade: (changed: boolean) => void,
): Promise<void> {
  const sa = `system:serviceaccount:kodra-agent:${NAME}`;
  const can = (verb: string, resource: string) =>
    spawnSync(
      'kubectl',
      [...kubectl.kubeconfigArgs, '-n', 'kodra-agent', 'auth', 'can-i', verb, resource, '--as', sa],
      { encoding: 'utf8' },
    ).stdout.trim();
  const expected: [string, string, string][] = [
    ['patch', `configmap/${fullname}-settings`, 'yes'],
    // Helm's own ConfigMap stays Helm's.
    ['patch', `configmap/${fullname}`, 'no'],
    ['patch', `secret/${NAME}-secrets`, 'yes'],
    ['patch', `deployment/${fullname}`, 'yes'],
    ['patch', 'configmap/other', 'no'],
    ['get', 'secret/other', 'no'],
    ['list', 'secrets', 'no'],
    ['delete', `configmap/${fullname}`, 'no'],
  ];
  for (const [verb, resource, answer] of expected) {
    if (can(verb, resource) !== answer) {
      throw new Error(`the agent's access to ${verb} ${resource} is not "${answer}"`);
    }
  }

  const port = 18081;
  const base = `http://127.0.0.1:${String(port)}`;
  const forward = () =>
    spawn(
      'kubectl',
      [
        ...kubectl.kubeconfigArgs,
        '-n',
        'kodra-agent',
        'port-forward',
        `svc/${fullname}-console`,
        `${String(port)}:8081`,
      ],
      { stdio: 'ignore' },
    );
  const signIn = async () => {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (login.status !== 200) throw new Error(`console sign-in: HTTP ${String(login.status)}`);
    return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  const reachable = () =>
    untilAsync(
      'the console through port-forward',
      async () => (await fetch(`${base}/api/session`).catch(() => null))?.ok === true,
      60_000,
    );

  let pf = forward();
  try {
    await reachable();
    let cookie = await signIn();
    const view = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as {
      editable?: boolean;
      base?: string;
    };
    if (view.editable !== true) throw new Error('settings are not editable on Kubernetes');
    const saved = await fetch(`${base}/api/settings/apply`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-kodra-console': '1' },
      body: JSON.stringify({ patch: { limits: { monthlyBudgetUsd: 25 } }, base: view.base }),
    });
    if (saved.status !== 200) throw new Error(`saving settings: HTTP ${String(saved.status)}`);

    const configMap = () =>
      JSON.parse(
        kubectl('-n', 'kodra-agent', 'get', 'configmap', `${fullname}-settings`, '-o', 'json'),
      ) as { data: Record<string, string> };
    if (!configMap().data['kodra-agent.yaml']?.includes('monthlyBudgetUsd: 25')) {
      throw new Error('the ConfigMap does not have the new setting');
    }
    await until(
      'the Deployment restart',
      () =>
        kubectl(
          '-n',
          'kodra-agent',
          'get',
          'deployment',
          fullname,
          '-o',
          'jsonpath={.spec.template.metadata.annotations.kodra\\.io/restartedAt}',
        ).trim() !== '',
      30_000,
    );
    show('kubectl', [
      ...kubectl.kubeconfigArgs,
      '-n',
      'kodra-agent',
      'rollout',
      'status',
      `deployment/${fullname}`,
      '--timeout',
      '180s',
    ]);

    // The budget the running pod uses, through a fresh port-forward (pods get replaced).
    const budget = async () => {
      pf.kill();
      pf = forward();
      await reachable();
      cookie = await signIn();
      const status = (await (
        await fetch(`${base}/api/status`, { headers: { cookie } })
      ).json()) as {
        budget?: { limit?: number | null };
      };
      return status.budget?.limit ?? null;
    };
    const rollout = () => {
      show('kubectl', [
        ...kubectl.kubeconfigArgs,
        '-n',
        'kodra-agent',
        'rollout',
        'status',
        `deployment/${fullname}`,
        '--timeout',
        '180s',
      ]);
    };
    if ((await budget()) !== 25) throw new Error('the new pod did not load the new setting');
    console.log('kind: a console setting was saved to the ConfigMap and a new pod runs with it');

    pf.kill();
    upgrade(false);
    rollout();
    const after = configMap().data;
    if (!after['kodra-agent.yaml']?.includes('monthlyBudgetUsd: 25') || (await budget()) !== 25) {
      throw new Error('helm upgrade with the same config dropped the console setting');
    }
    console.log('kind: helm upgrade with the same config kept the console setting');

    pf.kill();
    upgrade(true);
    rollout();
    if ((await budget()) === 25) {
      throw new Error('helm upgrade with a changed config did not replace the console setting');
    }
    console.log('kind: helm upgrade with a changed config replaced the console setting');
  } finally {
    pf.kill();
  }
}

/**
 * OpenShift (PLAN-v0.2 M12): the image runs as a random user in group 0, with a read-only root
 * filesystem. doctor passes its config and audit checks, and `run` answers /healthz.
 */
async function openshiftUser(): Promise<void> {
  console.log('\n== As an OpenShift user (1000680000:0), read-only root filesystem');
  const dir = writeBundle('compose', 'openshift');
  const name = 'kodra-openshift-test';
  const base = [
    '--user',
    '1000680000:0',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/var/lib/kodra-agent',
    '-v',
    `${dir}:/etc/kodra-agent:ro`,
    '-e',
    'KODRA_CONSOLE_TOKEN=openshift-test-token',
  ];
  const doctor = spawnSync('docker', ['run', '--rm', ...base, IMAGE, 'doctor', '--json'], {
    encoding: 'utf8',
  });
  const rows = (JSON.parse(doctor.stdout) as { checks: { check: string; status: string }[] })
    .checks;
  for (const check of ['kodra-agent.yaml', 'audit log']) {
    if (rows.find((r) => r.check === check)?.status !== 'pass') {
      throw new Error(`doctor's ${check} check fails as an OpenShift user:\n${doctor.stdout}`);
    }
  }
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  show('docker', ['run', '-d', '--name', name, ...base, IMAGE, 'run']);
  try {
    await until(
      '/healthz as an OpenShift user',
      () =>
        spawnSync('docker', [
          'exec',
          name,
          'node',
          '-e',
          "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ]).status === 0,
      60_000,
    );
  } catch (error) {
    spawnSync('docker', ['logs', name], { stdio: 'inherit' });
    throw error;
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
  console.log('openshift: doctor and /healthz work as a random user in group 0');
}

/**
 * The chart's alert rules (M14): promtool checks them, then a unit test feeds made-up series and
 * expects each alert to fire, with its labels and filled-in annotations.
 */
function alertRules(): void {
  console.log('\n== Chart alert rules with promtool');
  const dir = join(work, 'rules');
  mkdirSync(dir, { recursive: true });
  const rulesText = readFileSync(join(CHART, 'files', 'alerts.yaml'), 'utf8');
  writeFileSync(join(dir, 'alerts.yaml'), rulesText);
  const rules = (
    parse(rulesText) as {
      groups: {
        rules: {
          alert: string;
          labels: Record<string, string>;
          annotations: Record<string, string>;
        }[];
      }[];
    }
  ).groups.flatMap((g) => g.rules);
  const expect = (alert: string, labels: Record<string, string>) => {
    const rule = rules.find((r) => r.alert === alert);
    if (!rule) throw new Error(`no ${alert} rule`);
    const fill = (text: string) =>
      text.replace(/\{\{ \$labels\.(\w+) \}\}/g, (_, name: string) => labels[name] ?? '');
    return {
      alertname: alert,
      exp_alerts: [
        {
          exp_labels: { ...rule.labels, ...labels },
          exp_annotations: Object.fromEntries(
            Object.entries(rule.annotations).map(([k, v]) => [k, fill(v)]),
          ),
        },
      ],
    };
  };
  const test = {
    rule_files: ['alerts.yaml'],
    evaluation_interval: '1m',
    tests: [
      {
        interval: '1m',
        input_series: [
          { series: 'kodra_agent_connector_up{connector="grafana"}', values: '0x20' },
          { series: 'kodra_agent_connector_up{connector="kubernetes"}', values: '1x20' },
          { series: 'kodra_agent_errors_total{source="agent"}', values: '0+1x20' },
          { series: 'kodra_agent_approval_oldest_seconds', values: '0+60x20' },
          { series: 'kodra_agent_budget_remaining_ratio', values: '0.5 0.05x19' },
        ],
        alert_rule_test: [
          { eval_time: '5m', alertname: 'KodraAgentConnectorDown', exp_alerts: [] },
          { ...expect('KodraAgentConnectorDown', { connector: 'grafana' }), eval_time: '12m' },
          { ...expect('KodraAgentErrors', { source: 'agent' }), eval_time: '12m' },
          { eval_time: '10m', alertname: 'KodraAgentApprovalStuck', exp_alerts: [] },
          { ...expect('KodraAgentApprovalStuck', {}), eval_time: '16m' },
          { ...expect('KodraAgentBudgetLow', {}), eval_time: '5m' },
        ],
      },
    ],
  };
  writeFileSync(join(dir, 'alerts.test.yaml'), stringify(test));
  const promtool = (...args: string[]) => {
    show('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${dir}:/rules:ro`,
      '-w',
      '/rules',
      '--entrypoint',
      'promtool',
      PROMETHEUS,
      ...args,
    ]);
  };
  promtool('check', 'rules', 'alerts.yaml');
  promtool('test', 'rules', 'alerts.test.yaml');
  console.log('alert rules: valid, and each alert fires on its test series');
}

/** The chart's NetworkPolicy for each profile, with and without a proxy, and the Cilium one. */
function chartPolicies(): void {
  console.log('\n== Chart: NetworkPolicy per profile');
  const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
  const render = (example: string, ...set: string[]) =>
    parseAllDocuments(
      sh('helm', [
        'template',
        'np',
        CHART,
        '--set-file',
        `config=${join(examples, example)}`,
        '--set',
        'networkPolicy.apiServer.cidr=10.96.0.1/32',
        ...set.flatMap((s) => ['--set', s]),
      ]),
    )
      .map((d) => d.toJS() as { kind?: string; spec?: Record<string, unknown> } | null)
      .filter((d): d is { kind?: string; spec?: Record<string, unknown> } => d !== null);
  const policy = (docs: ReturnType<typeof render>) =>
    JSON.stringify(docs.find((d) => d.kind === 'NetworkPolicy') ?? null);
  if (policy(render('starter.yaml')) !== 'null')
    throw new Error('starter should have no NetworkPolicy');
  if (!policy(render('starter.yaml', 'networkPolicy.enabled=true')).includes('0.0.0.0/0')) {
    throw new Error('networkPolicy.enabled=true should turn it on for starter');
  }
  const team = policy(render('team.yaml'));
  for (const want of ['kube-dns', '10.96.0.1/32', '"monitoring"', '0.0.0.0/0']) {
    if (!team.includes(want)) throw new Error(`the team policy lacks ${want}: ${team}`);
  }
  if (team.includes('"com"')) throw new Error('gitlab.com was taken for an in-cluster service');
  const strict = sh('helm', [
    'template',
    'np',
    CHART,
    '--set-file',
    `config=${join(examples, 'strict.yaml')}`,
    '--set',
    'networkPolicy.apiServer.cidr=10.96.0.1/32',
  ]);
  if (!strict.includes('kind: NetworkPolicy'))
    throw new Error('strict should have a NetworkPolicy');
  const cilium = render('team.yaml', 'networkPolicy.cilium=true');
  const fqdn = JSON.stringify(cilium.find((d) => d.kind === 'CiliumNetworkPolicy') ?? null);
  for (const want of ['api.openai.com', 'gitlab.com', '*.slack.com']) {
    if (!fqdn.includes(want)) throw new Error(`the Cilium policy lacks ${want}: ${fqdn}`);
  }
  console.log('chart: NetworkPolicy off for starter, on for team and strict; Cilium names hosts');
}

try {
  servers();
  eksToken();
  chartPolicies();
  alertRules();
  await openshiftUser();
  await compose();
  shipInContainer();
  if (!process.argv.includes('--no-kind')) await kind();
  console.log('\nAll package checks passed.');
} catch (error) {
  console.error(
    `\nPackage check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
