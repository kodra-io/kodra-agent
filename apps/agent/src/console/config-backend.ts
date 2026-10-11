import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
} from '@kubernetes/client-node';
import { ENV_HEADER } from '../commands/init.ts';
import { dropEnvKeys, renderEnvFile, writePrivateFile } from '../env-file.ts';

/**
 * Where the console's settings live. With Docker Compose: kodra-agent.yaml, its `.previous`
 * copy, and `.env` next to it. On Kubernetes: the agent's own ConfigMap (the config and its
 * previous copy) and Secret, which the chart lets it read and patch and nothing else.
 */
export interface ConfigBackend {
  readonly where: 'files' | 'kubernetes';
  /** Whether secrets can be written (on Kubernetes, only with the agent's Secret). */
  readonly envWritable: boolean;
  read(): Promise<string>;
  readPrevious(): Promise<string | null>;
  /** Saves the config, keeping `previous` for Undo. */
  save(text: string, previous: string): Promise<void>;
  /** Sets and removes environment values (.env, or the Secret). */
  writeEnv(set: ReadonlyMap<string, string>, remove: readonly string[]): Promise<void>;
}

export function fileBackend(configPath: string): ConfigBackend {
  const backupPath = `${configPath}.previous`;
  const envPath = join(dirname(configPath), '.env');
  return {
    where: 'files',
    envWritable: true,
    read: () => readFile(configPath, 'utf8'),
    readPrevious: () => readFile(backupPath, 'utf8').catch(() => null),
    async save(text, previous) {
      await writeFile(backupPath, previous, 'utf8');
      const temp = `${configPath}.${String(process.pid)}.tmp`;
      await writeFile(temp, text, 'utf8');
      await rename(temp, configPath);
    },
    async writeEnv(set, remove) {
      const existing = await readFile(envPath, 'utf8').catch(() => null);
      await writePrivateFile(
        envPath,
        renderEnvFile(dropEnvKeys(existing, remove), set, ENV_HEADER),
      );
    },
  };
}

/** The agent's own objects, from the environment the chart sets. */
export interface SelfNames {
  namespace: string;
  configMap: string;
  deployment: string;
  /** The Secret the agent's environment comes from; without one, secrets are read-only. */
  secret: string | null;
}

export const CONFIG_KEY = 'kodra-agent.yaml';
export const PREVIOUS_KEY = 'kodra-agent.yaml.previous';
export const RESTARTED_AT = 'kodra.io/restartedAt';

export function selfNames(env: Readonly<Record<string, string | undefined>>): SelfNames | null {
  const namespace = env['KODRA_AGENT_NAMESPACE'];
  const configMap = env['KODRA_AGENT_CONFIGMAP'];
  const deployment = env['KODRA_AGENT_DEPLOYMENT'];
  if (!namespace || !configMap || !deployment) return null;
  return { namespace, configMap, deployment, secret: env['KODRA_AGENT_SECRET'] || null };
}

/** The few calls the agent makes on its own objects, behind an interface for tests. */
export interface SelfKubernetes {
  readConfigMap(namespace: string, name: string): Promise<Record<string, string>>;
  /** A merge patch of the ConfigMap's data. */
  patchConfigMap(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /** A merge patch of the Secret's data: values are plain text here; null removes a key. */
  patchSecret(namespace: string, name: string, data: Record<string, string | null>): Promise<void>;
  /** Sets the pod template annotation, as `kubectl rollout restart` does. */
  restartDeployment(namespace: string, name: string, at: string): Promise<void>;
}

const mergePatch = () => setHeaderOptions('Content-Type', PatchStrategy.MergePatch);

/** Uses the pod's service account, never a kubeconfig the connectors use. */
export function realSelfKubernetes(): SelfKubernetes {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  return {
    async readConfigMap(namespace, name) {
      return (await core.readNamespacedConfigMap({ namespace, name })).data ?? {};
    },
    async patchConfigMap(namespace, name, data) {
      await core.patchNamespacedConfigMap({ namespace, name, body: { data } }, mergePatch());
    },
    async patchSecret(namespace, name, data) {
      const encoded = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [
          k,
          v === null ? null : Buffer.from(v, 'utf8').toString('base64'),
        ]),
      );
      await core.patchNamespacedSecret({ namespace, name, body: { data: encoded } }, mergePatch());
    },
    async restartDeployment(namespace, name, at) {
      await apps.patchNamespacedDeployment(
        {
          namespace,
          name,
          body: { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: at } } } } },
        },
        mergePatch(),
      );
    },
  };
}

export function kubernetesBackend(
  client: SelfKubernetes,
  names: SelfNames,
): ConfigBackend & { restart(at: Date): Promise<void> } {
  const { namespace, configMap, deployment, secret } = names;
  return {
    where: 'kubernetes',
    envWritable: secret !== null,
    // Read from the API, not the mounted file, which the kubelet updates only after a while.
    async read() {
      const text = (await client.readConfigMap(namespace, configMap))[CONFIG_KEY];
      if (text === undefined) throw new Error(`ConfigMap ${configMap} has no ${CONFIG_KEY}`);
      return text;
    },
    async readPrevious() {
      return (await client.readConfigMap(namespace, configMap))[PREVIOUS_KEY] ?? null;
    },
    async save(text, previous) {
      await client.patchConfigMap(namespace, configMap, {
        [CONFIG_KEY]: text,
        [PREVIOUS_KEY]: previous,
      });
    },
    async writeEnv(set, remove) {
      if (!secret) throw new Error('the agent has no Secret to write to (existingSecret)');
      const data: Record<string, string | null> = Object.fromEntries(set);
      for (const key of remove) data[key] = null;
      await client.patchSecret(namespace, secret, data);
    },
    // A new pod mounts the new ConfigMap and reads the Secret into its environment.
    restart: (at) => client.restartDeployment(namespace, deployment, at.toISOString()),
  };
}
