import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

/**
 * The few calls a sandbox test makes besides Helm (B2), all in the sandbox namespace and all
 * allowed by its Role: a ConfigMap of placeholders, the release's pods and services, and one
 * HTTP request through the API server's service proxy. Behind an interface so tests need no
 * cluster.
 */
export interface SandboxCluster {
  createConfigMap(
    namespace: string,
    name: string,
    labels: Record<string, string>,
    data: Record<string, string>,
  ): Promise<void>;
  configMaps(
    namespace: string,
    labelSelector: string,
  ): Promise<{ name: string; labels: Record<string, string>; created: string }[]>;
  deleteConfigMap(namespace: string, name: string): Promise<void>;
  pods(namespace: string, labelSelector: string): Promise<SandboxPod[]>;
  services(namespace: string, labelSelector: string): Promise<{ name: string; port: string }[]>;
  /** GET through the API server's service proxy; the HTTP status, or 0 when unreachable. */
  get(namespace: string, service: string, port: string, path: string): Promise<number>;
}

export interface SandboxPod {
  name: string;
  ready: boolean;
  restarts: number;
  /** Why a container is not running, like ImagePullBackOff or CrashLoopBackOff. */
  waiting: string | null;
}

export type SandboxClusterFactory = (kubeconfig?: string) => SandboxCluster;

export const realSandboxCluster: SandboxClusterFactory = (kubeconfig) => {
  const kc = new KubeConfig();
  if (kubeconfig) kc.loadFromString(kubeconfig);
  else kc.loadFromDefault();
  const api = kc.makeApiClient(CoreV1Api);
  return {
    async createConfigMap(namespace, name, labels, data) {
      await api.createNamespacedConfigMap({
        namespace,
        body: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace, labels }, data },
      });
    },
    async configMaps(namespace, labelSelector) {
      const list = await api.listNamespacedConfigMap({ namespace, labelSelector });
      return list.items.map((cm) => ({
        name: cm.metadata?.name ?? '',
        labels: cm.metadata?.labels ?? {},
        created: cm.metadata?.creationTimestamp?.toISOString() ?? '',
      }));
    },
    async deleteConfigMap(namespace, name) {
      try {
        await api.deleteNamespacedConfigMap({ name, namespace });
      } catch (error) {
        if ((error as { code?: unknown }).code !== 404) throw error;
      }
    },
    async pods(namespace, labelSelector) {
      const list = await api.listNamespacedPod({ namespace, labelSelector });
      return list.items.map((p) => {
        const statuses = p.status?.containerStatuses ?? [];
        return {
          name: p.metadata?.name ?? '',
          ready: statuses.length > 0 && statuses.every((s) => s.ready),
          restarts: statuses.reduce((n, s) => n + s.restartCount, 0),
          waiting: statuses.map((s) => s.state?.waiting?.reason).find(Boolean) ?? null,
        };
      });
    },
    async services(namespace, labelSelector) {
      const list = await api.listNamespacedService({ namespace, labelSelector });
      return list.items.map((s) => {
        const port = s.spec?.ports?.[0];
        return { name: s.metadata?.name ?? '', port: port?.name ?? String(port?.port ?? '') };
      });
    },
    async get(namespace, service, port, path) {
      try {
        await api.connectGetNamespacedServiceProxyWithPath({
          name: `${service}:${port}`,
          namespace,
          path: path.replace(/^\/+/, ''),
        });
        return 200;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'number' ? code : 0;
      }
    },
  };
};
