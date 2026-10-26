import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type V1Pod,
} from '@kubernetes/client-node';
import { AGENT_NAMESPACE, emptyDraft, rbacYaml } from '@kodra-agent/templates';
import { parseAllDocuments } from 'yaml';
import type { Exec } from '../ship/exec.ts';
import type { ReadyCondition, Scenario } from './scenario.ts';

/**
 * The throwaway kind cluster that scenarios run on (L3), for `pnpm eval` and
 * `kodra-agent demo`. kind runs as a program; everything else goes through the Kubernetes
 * client, so the image needs no kubectl.
 */

/** The agent's service account: read-only, bound by the bundle's own rbac.yaml. */
export const AGENT_ACCOUNT = 'kodra-eval-agent';
const FIELD_MANAGER = 'kodra-agent-eval';

export interface KindCluster {
  name: string;
  /** The admin kubeconfig: sets up scenarios and watches them. Never given to the agent. */
  admin: string;
}

async function kind(exec: Exec, bin: string, args: string[], timeoutMs = 300_000): Promise<string> {
  const r = await exec(bin, args, { timeoutMs });
  if (r.code !== 0) {
    throw new Error(
      `${bin} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`,
    );
  }
  return r.stdout;
}

export async function clusterExists(exec: Exec, bin: string, name: string): Promise<boolean> {
  return (await kind(exec, bin, ['get', 'clusters'])).split(/\s+/).includes(name);
}

/**
 * Creates the cluster (or reuses one of that name) and returns its admin kubeconfig.
 * `internal` gives the address on kind's Docker network, for a caller inside a container.
 */
export async function createCluster(
  exec: Exec,
  bin: string,
  name: string,
  internal: boolean,
): Promise<KindCluster> {
  if (!(await clusterExists(exec, bin, name))) {
    await kind(exec, bin, ['create', 'cluster', '--name', name, '--wait', '180s'], 600_000);
  }
  const admin = await kind(exec, bin, [
    'get',
    'kubeconfig',
    '--name',
    name,
    ...(internal ? ['--internal'] : []),
  ]);
  return { name, admin };
}

export async function deleteCluster(exec: Exec, bin: string, name: string): Promise<boolean> {
  if (!(await clusterExists(exec, bin, name))) return false;
  await kind(exec, bin, ['delete', 'cluster', '--name', name]);
  return true;
}

const config = (kubeconfig: string) => {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  return kc;
};

/** Creates or updates each object (server-side apply), in order. */
export async function applyAll(
  kubeconfig: string,
  docs: readonly Record<string, unknown>[],
): Promise<void> {
  const api = KubernetesObjectApi.makeApiClient(config(kubeconfig));
  for (const doc of docs) {
    await api.patch(doc, undefined, undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply);
  }
}

/** Whether one pod meets a condition. */
export function podMatches(pod: V1Pod, cond: ReadyCondition): boolean {
  if (cond.app && pod.metadata?.labels?.['app'] !== cond.app) return false;
  const reason = cond.reason ? new RegExp(`^(${cond.reason})$`) : null;
  const statuses = pod.status?.containerStatuses ?? [];
  switch (cond.state) {
    case 'pending':
      return pod.status?.phase === 'Pending' && statuses.every((s) => !s.state?.running);
    case 'running':
      return (
        pod.status?.phase === 'Running' &&
        statuses.length > 0 &&
        statuses.every((s) => s.state?.running)
      );
    case 'not-ready':
      return (
        pod.status?.phase === 'Running' &&
        statuses.length > 0 &&
        statuses.every((s) => s.state?.running && !s.ready)
      );
    case 'restarted':
      return statuses.some((s) => s.restartCount >= 1);
    case 'waiting':
      return statuses.some(
        (s) => s.state?.waiting && (!reason || reason.test(s.state.waiting.reason ?? '')),
      );
    case 'terminated':
      return statuses.some((s) => {
        const t = s.state?.terminated ?? s.lastState?.terminated;
        return t !== undefined && (!reason || reason.test(t.reason ?? ''));
      });
  }
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until the namespace has a pod meeting every condition, or throws after the timeout. */
export async function waitReady(
  kubeconfig: string,
  scenario: Scenario,
  timeoutMs: number,
): Promise<void> {
  const core = config(kubeconfig).makeApiClient(CoreV1Api);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pods = (await core.listNamespacedPod({ namespace: scenario.id })).items;
    if (scenario.ready.every((c) => pods.some((p) => podMatches(p, c)))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${scenario.id} never got ready (${scenario.ready.map((c) => c.state + (c.reason ? ` ${c.reason}` : '')).join(', ')})`,
      );
    }
    await pause(3000);
  }
}

/** Waits until every Deployment in the namespace has rolled out its latest template. */
export async function waitRollout(
  kubeconfig: string,
  namespace: string,
  timeoutMs: number,
): Promise<void> {
  const apps = config(kubeconfig).makeApiClient(AppsV1Api);
  const core = config(kubeconfig).makeApiClient(CoreV1Api);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const deployments = (await apps.listNamespacedDeployment({ namespace })).items;
    const pods = (await core.listNamespacedPod({ namespace })).items;
    const done = deployments.every((d) => {
      const want = d.spec?.replicas ?? 1;
      const s = d.status;
      return (
        (s?.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) &&
        (s?.updatedReplicas ?? 0) === want &&
        (s?.readyReplicas ?? 0) === want
      );
    });
    // Old pods still terminating would show the previous release's logs.
    if (done && pods.length === deployments.reduce((n, d) => n + (d.spec?.replicas ?? 1), 0))
      return;
    if (Date.now() > deadline) throw new Error(`${namespace} never finished rolling out`);
    await pause(3000);
  }
}

/**
 * A kubeconfig for the agent's own service account, read-only in the given namespaces, with
 * exactly the Role the Kubernetes bundle grants (rbac.yaml). The agent never gets the admin one.
 */
export async function agentKubeconfig(
  kubeconfig: string,
  namespaces: readonly string[],
): Promise<string> {
  const kc = config(kubeconfig);
  const rbac = rbacYaml({
    ...emptyDraft(),
    name: AGENT_ACCOUNT,
    target: 'kubernetes',
    connectors: {
      kubernetes: {
        enabled: true,
        access: 'read-only',
        config: { namespaces: namespaces.join(', ') },
        optionalSecrets: [],
      },
    },
  });
  if (!rbac) throw new Error('the bundle made no rbac.yaml');
  await applyAll(kubeconfig, [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: AGENT_NAMESPACE } },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: AGENT_ACCOUNT, namespace: AGENT_NAMESPACE },
    },
    ...parseAllDocuments(rbac).map((d) => d.toJS() as Record<string, unknown>),
  ]);
  const token = await kc.makeApiClient(CoreV1Api).createNamespacedServiceAccountToken({
    name: AGENT_ACCOUNT,
    namespace: AGENT_NAMESPACE,
    body: { spec: { expirationSeconds: 4 * 3600 } },
  });
  const cluster = kc.getCurrentCluster();
  if (!cluster || !token.status?.token) throw new Error('could not make the agent kubeconfig');
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'kind',
        cluster: { server: cluster.server, 'certificate-authority-data': cluster.caData },
      },
    ],
    users: [{ name: AGENT_ACCOUNT, user: { token: token.status.token } }],
    contexts: [{ name: AGENT_ACCOUNT, context: { cluster: 'kind', user: AGENT_ACCOUNT } }],
    'current-context': AGENT_ACCOUNT,
  });
}
