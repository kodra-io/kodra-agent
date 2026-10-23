import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

/** The few Kubernetes calls M3 needs, behind an interface so tests need no cluster. */
export interface KubernetesClient {
  listPods(namespace: string, timeoutMs: number): Promise<number>;
  /** Creates the Secret, or replaces its data if it exists. Returns which one happened. */
  upsertSecret(
    namespace: string,
    name: string,
    stringData: Record<string, string>,
  ): Promise<'created' | 'updated'>;
}

/**
 * Builds a client from a kubeconfig's contents, or from the default locations. `execEnv` goes
 * to the kubeconfig's exec plugin (an EKS kubeconfig's `aws eks get-token` gets its keys).
 */
export type KubernetesFactory = (
  kubeconfig?: string,
  execEnv?: Readonly<Record<string, string>>,
) => KubernetesClient;

export const realKubernetes: KubernetesFactory = (kubeconfig, execEnv) => {
  const kc = new KubeConfig();
  if (kubeconfig) kc.loadFromString(kubeconfig);
  else kc.loadFromDefault();
  if (!kc.getCurrentCluster()) throw new Error('no current cluster in the kubeconfig');
  const extra = Object.entries(execEnv ?? {}).map(([name, value]) => ({ name, value }));
  if (extra.length > 0) {
    kc.loadFromOptions({
      clusters: kc.clusters,
      contexts: kc.contexts,
      currentContext: kc.currentContext,
      users: kc.users.map((u) => {
        const exec = u.exec as { env?: { name: string; value: string }[] } | undefined;
        return exec ? { ...u, exec: { ...exec, env: [...(exec.env ?? []), ...extra] } } : u;
      }),
    });
  }
  const api = kc.makeApiClient(CoreV1Api);
  return {
    async listPods(namespace, timeoutMs) {
      const list = await api.listNamespacedPod({
        namespace,
        limit: 1,
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
      });
      return list.items.length;
    },
    async upsertSecret(namespace, name, stringData) {
      const body = {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          name,
          namespace,
          labels: { 'app.kubernetes.io/managed-by': 'kodra-agent-init' },
        },
        stringData,
      };
      try {
        await api.readNamespacedSecret({ name, namespace });
      } catch (error) {
        if ((error as { code?: unknown }).code === 404) {
          await api.createNamespacedSecret({ namespace, body });
          return 'created';
        }
        throw error;
      }
      await api.replaceNamespacedSecret({ name, namespace, body });
      return 'updated';
    },
  };
};
