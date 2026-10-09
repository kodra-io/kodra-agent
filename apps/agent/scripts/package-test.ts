import { execFileSync, spawnSync } from 'node:child_process';
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
 *      answers /healthz and /readyz;
 *   3. on a throwaway kind cluster, the chart installs with the bundle's values.yaml and
 *      the pod becomes ready (skip with --no-kind).
 * The kind kubeconfig goes to a temporary file: the user's kube context is never changed.
 */
const IMAGE = process.env['KODRA_IMAGE'] ?? `${AGENT_IMAGE}:${AGENT_VERSION}`;
const KIND = process.env['KIND'] ?? 'kind';
const CLUSTER = 'kodra-agent-package';
const NAME = 'package-test';
const SAMPLE = fileURLToPath(new URL('../../../examples/ship/go', import.meta.url));
const CHART = fileURLToPath(new URL('../../../charts/kodra-agent', import.meta.url));
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
    policy: { approvers: '@ops', expiresAfterMinutes: '15', destructiveActions: 'deny' },
  };
}

function writeBundle(
  target: AgentDraft['target'],
  folder: string = target,
  connectors: AgentDraft['connectors'] = {},
): string {
  const dir = join(work, folder);
  for (const file of generateBundle(draft(target, connectors)).files) {
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
  const dir = writeBundle('compose');
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
  console.log(`console: signed in on ${base}, agent ${status.version}`);
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

/** `ship` inside the agent container, through the bundle, with Docker build access. */
function shipInContainer(): void {
  console.log('\n== ship inside the agent container (Docker build access)');
  const docker = getConnector('docker');
  if (!docker) throw new Error('no Docker connector');
  const dir = writeBundle('compose', 'ship', {
    docker: { ...connectorDefaults(docker, 'compose'), access: 'read-write-approved' },
  });
  writeFileSync(join(dir, '.env'), linuxEnv(true));
  // A sample app inside the bundle folder, which the container sees at /etc/kodra-agent.
  cpSync(SAMPLE, join(dir, 'go-api'), { recursive: true });
  show(
    'docker',
    ['compose', 'run', '--rm', '-T', 'kodra-agent', 'ship', '/etc/kodra-agent/go-api'],
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
  console.log('ship: built, started, and checked the app from inside the agent container');
  spawnSync('docker', ['compose', 'down', '-v'], { cwd: dir, stdio: 'inherit' });
}

function kind(): void {
  console.log('\n== Helm chart on kind, with the bundle values');
  const dir = writeBundle('kubernetes');
  const kubeconfig = join(work, 'kubeconfig');
  const kubectl = (...args: string[]) => sh('kubectl', ['--kubeconfig', kubeconfig, ...args]);
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
    );
    const [repository, tag] = [
      IMAGE.slice(0, IMAGE.lastIndexOf(':')),
      IMAGE.slice(IMAGE.lastIndexOf(':') + 1),
    ];
    show(
      'helm',
      [
        'install',
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

try {
  servers();
  eksToken();
  await compose();
  shipInContainer();
  if (!process.argv.includes('--no-kind')) kind();
  console.log('\nAll package checks passed.');
} catch (error) {
  console.error(
    `\nPackage check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
