import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * pnpm test:kind: creates a throwaway kind cluster with a crashlooping deployment, runs
 * src/kind.e2e.test.ts against it, and deletes the cluster. The cluster's kubeconfig goes
 * to a temporary file, so the user's own kube context is never changed.
 */
const KIND = process.env['KIND'] ?? 'kind';
const CLUSTER = 'kodra-agent-e2e';
// On Windows, stay on the working drive: kodra-agent.yaml file references are POSIX paths.
const base =
  process.platform === 'win32'
    ? join(process.cwd(), 'node_modules', '.cache', 'kodra-kind')
    : tmpdir();
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'kodra-kind-'));
const kubeconfig = join(dir, 'kubeconfig');

const MANIFEST = `apiVersion: v1
kind: Namespace
metadata:
  name: payments
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashloop
  namespace: payments
spec:
  replicas: 1
  selector:
    matchLabels: {app: crashloop}
  template:
    metadata:
      labels: {app: crashloop}
    spec:
      containers:
        - name: app
          image: busybox:1.37
          command: ["sh", "-c", "echo 'Error: cannot connect to database at db:5432: connection refused'; sleep 2; exit 1"]
`;

function sh(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...(input ? { input } : {}),
  });
}

const kubectl = (...args: string[]) => sh('kubectl', ['--kubeconfig', kubeconfig, ...args]);

/** POSIX form of a local path, as kodra-agent.yaml requires (drive letter dropped on Windows). */
const posix = (p: string) => (process.platform === 'win32' ? p.slice(2).replaceAll('\\', '/') : p);

/**
 * `pnpm test:kind --demo`: the same cluster, then an interactive chat with a real model.
 * Needs ANTHROPIC_API_KEY and KODRA_DEMO_MODEL (a model id from the Anthropic docs).
 */
function demo(): number {
  const model = process.env['KODRA_DEMO_MODEL'];
  if (!process.env['ANTHROPIC_API_KEY'] || !model) {
    console.error('Set ANTHROPIC_API_KEY and KODRA_DEMO_MODEL to run the demo.');
    return 1;
  }
  const config = join(dir, 'kodra-agent.yaml');
  writeFileSync(
    config,
    `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: crashloop-demo
spec:
  target: compose
  model:
    provider: anthropic
    name: '${model}'
    apiKey: \${env:ANTHROPIC_API_KEY}
  connectors:
    kubernetes:
      enabled: true
      access: read-write-approved
      config:
        namespaces: [payments]
      secrets:
        kubeconfig: '\${file:${posix(kubeconfig)}}'
  policy:
    approvals:
      approvers: ['@you']
  audit:
    path: ${posix(join(dir, 'audit.jsonl'))}
`,
  );
  console.log('Try: "why is the crashloop deployment in payments failing?"');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      'src/bin.ts',
      'chat',
      '--config',
      config,
    ],
    { stdio: 'inherit' },
  );
  console.log(`Audit log: ${join(dir, 'audit.jsonl')}`);
  return result.status ?? 1;
}

let code = 1;
try {
  console.log(`Creating kind cluster ${CLUSTER} (kubeconfig ${kubeconfig})`);
  sh(KIND, ['create', 'cluster', '--name', CLUSTER, '--kubeconfig', kubeconfig, '--wait', '180s']);
  writeFileSync(join(dir, 'crashloop.yaml'), MANIFEST);
  kubectl('apply', '-f', join(dir, 'crashloop.yaml'));

  console.log('Waiting for the pod to crash at least once');
  const deadline = Date.now() + 180_000;
  for (;;) {
    const restarts = kubectl(
      '-n',
      'payments',
      'get',
      'pods',
      '-l',
      'app=crashloop',
      '-o',
      'jsonpath={.items[0].status.containerStatuses[0].restartCount}',
    );
    if (Number(restarts) >= 1) break;
    if (Date.now() > deadline) throw new Error('the pod never restarted');
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
  }

  if (process.argv.includes('--demo')) {
    code = demo();
  } else {
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'src/kind.e2e.test.ts'], {
      stdio: 'inherit',
      env: { ...process.env, KODRA_KIND_KUBECONFIG: kubeconfig },
      shell: process.platform === 'win32',
    });
    code = result.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (!process.env['KODRA_KEEP_KIND']) {
    spawnSync(KIND, ['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', kubeconfig], {
      stdio: 'inherit',
    });
  }
}
process.exitCode = code;
