/**
 * The agent's access in its sandbox namespace (B2): create, change, and delete the workloads a
 * test deploy makes, read their pods and logs, and call the service through the API server
 * for the smoke test. Never Secrets: Helm keeps its records in ConfigMaps (HELM_DRIVER).
 * The bundle's rbac.yaml, the chart, and the kubeconfig steps all use these rules.
 */
export const SANDBOX_RULES: readonly { apiGroup: string; resources: string[]; verbs: string[] }[] =
  [
    {
      apiGroup: '',
      resources: ['configmaps', 'services'],
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
    },
    {
      apiGroup: 'apps',
      resources: ['deployments'],
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
    },
    { apiGroup: 'apps', resources: ['replicasets'], verbs: ['get', 'list', 'watch'] },
    { apiGroup: '', resources: ['pods', 'pods/log', 'events'], verbs: ['get', 'list', 'watch'] },
    { apiGroup: '', resources: ['services/proxy'], verbs: ['get'] },
  ];

/** The rules as YAML list items, indented for a Role's `rules:`. */
export function sandboxRulesYaml(indent: number): string {
  const pad = ' '.repeat(indent);
  const list = (items: readonly string[]) => `[${items.map((i) => JSON.stringify(i)).join(', ')}]`;
  return SANDBOX_RULES.map(
    (r) =>
      `${pad}- apiGroups: [${JSON.stringify(r.apiGroup)}]\n${pad}  resources: ${list(r.resources)}\n${pad}  verbs: ${list(r.verbs)}`,
  ).join('\n');
}

/** Namespaces that can never be the sandbox: the cluster's own, and the default one. */
export const NOT_A_SANDBOX = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];
