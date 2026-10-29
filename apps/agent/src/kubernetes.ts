import { AuthorizationV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';

/** The few Kubernetes calls M3 needs, behind an interface so tests need no cluster. */
export interface KubernetesClient {
  listPods(namespace: string, timeoutMs: number): Promise<number>;
  /** Creates the Secret, or replaces its data if it exists. Returns which one happened. */
  upsertSecret(
    namespace: string,
    name: string,
    stringData: Record<string, string>,
  ): Promise<'created' | 'updated'>;
  /**
   * Whether the credential may do each thing (SelfSubjectAccessReview, M29). No namespace
   * means in every namespace.
   */
  canI(checks: readonly AccessCheck[]): Promise<boolean[]>;
}

export interface AccessCheck {
  verb: string;
  resource: string;
  group?: string;
  /** Like `scale` for `deployments/scale`. */
  subresource?: string;
  namespace?: string;
}

/**
 * Builds a client from a kubeconfig's contents, or from the default locations. An exec plugin
 * (like an EKS kubeconfig's `aws eks get-token`) gets the agent's own environment.
 */
export type KubernetesFactory = (kubeconfig?: string) => KubernetesClient;

export const realKubernetes: KubernetesFactory = (kubeconfig) => {
  const kc = new KubeConfig();
  if (kubeconfig) kc.loadFromString(kubeconfig);
  else kc.loadFromDefault();
  if (!kc.getCurrentCluster()) throw new Error('no current cluster in the kubeconfig');
  const api = kc.makeApiClient(CoreV1Api);
  const auth = kc.makeApiClient(AuthorizationV1Api);
  return {
    async canI(checks) {
      const answers: boolean[] = [];
      for (const c of checks) {
        const review = await auth.createSelfSubjectAccessReview({
          body: {
            spec: {
              resourceAttributes: {
                verb: c.verb,
                resource: c.resource,
                group: c.group ?? '',
                ...(c.subresource === undefined ? {} : { subresource: c.subresource }),
                ...(c.namespace === undefined ? {} : { namespace: c.namespace }),
              },
            },
          },
        });
        answers.push(review.status?.allowed === true);
      }
      return answers;
    },
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
