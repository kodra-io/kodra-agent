import type { Component } from './config.ts';
import type { AccessCheck, KubernetesClient, KubernetesFactory } from './kubernetes.ts';

/**
 * Whether a credential reaches further than the agent needs (M29). The agent reads workloads
 * in its namespaces and, with write access, scales them: a credential that can do anything,
 * read Secrets (resources_get would hand them to the model), or change deployments in every
 * namespace is refused unless the connector sets allowBroadCredentials.
 */

export const BROAD_HINT =
  'Make a kubeconfig for a read-only service account with the steps under the kubeconfig, or set allowBroadCredentials: true on the connector to keep this one (the agent then warns at every start).';

/**
 * The namespaces where reading Secrets is too much: the watched ones and the sandbox (B2),
 * where the agent deploys but must never read the team's test Secret.
 */
export function secretNamespaces(settings: Readonly<Record<string, unknown>>): string[] {
  const watched = Array.isArray(settings['namespaces']) ? settings['namespaces'].map(String) : [];
  const sandbox = typeof settings['sandbox'] === 'string' ? settings['sandbox'].trim() : '';
  return sandbox && !watched.includes(sandbox) ? [...watched, sandbox] : watched;
}

/** What is too broad about a kubeconfig, in plain words; empty when its reach is right. */
export async function kubernetesScopeProblems(
  client: KubernetesClient,
  namespaces: readonly string[],
): Promise<string[]> {
  const checks: { check: AccessCheck; problem: string }[] = [
    {
      check: { verb: '*', resource: '*', group: '*' },
      problem: 'it is cluster-admin (it can do anything in the cluster)',
    },
    {
      check: { verb: 'get', resource: 'secrets' },
      problem: 'it can read Secrets in every namespace',
    },
    ...namespaces.map((ns) => ({
      check: { verb: 'get', resource: 'secrets', namespace: ns },
      problem: `it can read Secrets in ${ns}`,
    })),
    {
      check: { verb: 'patch', resource: 'deployments', group: 'apps' },
      problem: 'it can change deployments in every namespace',
    },
    {
      check: { verb: 'update', resource: 'deployments', subresource: 'scale', group: 'apps' },
      problem: 'it can scale deployments in every namespace',
    },
  ];
  const allowed = await client.canI(checks.map((c) => c.check));
  const has = (i: number) => allowed[i] === true;
  // Cluster-admin covers the rest; Secrets everywhere covers each namespace's.
  if (has(0)) return [checks[0]?.problem ?? ''];
  return checks.flatMap((c, i) =>
    has(i) && !(has(1) && c.check.resource === 'secrets' && c.check.namespace) ? [c.problem] : [],
  );
}

export const BROAD_REASON = 'its credential has more access than the agent needs';

/**
 * At startup: why a connector is refused for a broad credential, or null to start it. A
 * kept one (allowBroadCredentials) and a cluster that cannot answer are not refused: the
 * first was chosen and audited, the second is for the connector's own checks to report.
 */
export async function startupScopeProblem(
  comp: Component,
  secrets: Readonly<Record<string, string>>,
  kubernetes: KubernetesFactory,
  timeoutMs: number,
): Promise<{ refused: string } | { kept: string[] } | null> {
  if (comp.manifest.credentialScope !== 'kubernetes-rbac') return null;
  const namespaces = secretNamespaces(comp.settings);
  let problems: string[] | null;
  try {
    const client = kubernetes(secrets['kubeconfig']);
    let timer: ReturnType<typeof setTimeout> | undefined;
    problems = await Promise.race([
      kubernetesScopeProblems(client, namespaces),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
  } catch {
    problems = null;
  }
  if (!problems || problems.length === 0) return null;
  if (comp.allowBroadCredentials) return { kept: problems };
  return { refused: `${BROAD_REASON}: ${problems.join('; ')}` };
}
