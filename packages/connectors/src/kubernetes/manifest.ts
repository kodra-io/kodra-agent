import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS } from '../shared.ts';
import { EKS_KEY_STEPS, KUBECONFIG_STEPS } from './steps.ts';

const readSummary =
  'Reads pods, logs, events, deployments, and services in the listed namespaces only. Never reads Secrets.';

const readRbac =
  'get, list, watch on pods, pods/log, events, deployments, replicasets, services in the listed namespaces';

/**
 * Server config: only these tools are exposed, and these kinds are refused even when a
 * Role would allow them. Read-only access adds --read-only, which drops resources_scale.
 * See docs/connectors/kubernetes.md.
 */
const SERVER_CONFIG = `toolsets = ["core"]
enabled_tools = ["events_list", "pods_get", "pods_list_in_namespace", "pods_log", "resources_get", "resources_list", "resources_scale"]

[[denied_resources]]
group = ""
version = "v1"
kind = "Secret"

[[denied_resources]]
group = ""
version = "v1"
kind = "ServiceAccount"

[[denied_resources]]
group = "rbac.authorization.k8s.io"
version = "v1"
kind = "Role"

[[denied_resources]]
group = "rbac.authorization.k8s.io"
version = "v1"
kind = "RoleBinding"

[[denied_resources]]
group = "rbac.authorization.k8s.io"
version = "v1"
kind = "ClusterRole"

[[denied_resources]]
group = "rbac.authorization.k8s.io"
version = "v1"
kind = "ClusterRoleBinding"
`;

/** The agent never changes itself: its Deployment, pods, config, or Secret (PLAN-v0.2 M11). */
const notSelf: ToolGuard = { kind: 'not-self', namespaceArg: 'namespace', nameArg: 'name' };

const inNamespace: ToolGuard[] = [
  {
    kind: 'arg-in-setting',
    arg: 'namespace',
    setting: 'namespaces',
    required: true,
    scope: 'namespace',
  },
];

export default defineManifest({
  id: 'kubernetes',
  displayName: 'Kubernetes',
  category: 'deploy',
  status: 'available',
  description:
    'Inspect workloads in EKS, AKS, GKE, or on-prem clusters. With write access, scale deployments.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string-list',
      key: 'namespaces',
      required: true,
      description: 'Namespaces the agent may access. Nothing outside them.',
      pattern: PATTERNS.k8sNamespace,
      patternHint: 'use a Kubernetes namespace name: lowercase letters, digits, and hyphens',
      example: ['payments'],
    },
    {
      kind: 'string-list',
      key: 'databases',
      required: false,
      description:
        'Database workloads to watch on the console Overview, as namespace/name (a StatefulSet or Deployment). The namespace must be in the list above. For databases outside the cluster, or to check the database itself, use the Databases connector.',
      pattern: PATTERNS.k8sWorkload,
      patternHint: 'use namespace/name, like prod/mariadb',
      example: ['payments/postgres'],
    },
    {
      kind: 'string',
      key: 'sandbox',
      required: false,
      description:
        'A namespace where the agent may test-deploy a pull request after one approval, then delete it. Leave empty to turn this off. It must not be one of the namespaces above. Keep only test settings in it: anything deployed there can read its Secrets.',
      pattern: PATTERNS.k8sNamespace,
      patternHint: 'use a Kubernetes namespace name: lowercase letters, digits, and hyphens',
      example: 'sandbox',
    },
    {
      kind: 'string',
      key: 'sandboxPullSecret',
      required: false,
      description:
        'An image pull Secret in the sandbox namespace, when the pull request images are in a private registry.',
      pattern: PATTERNS.k8sNamespace,
      patternHint: 'use the name of a Secret in the sandbox namespace',
      example: 'ghcr',
    },
  ],
  secrets: [
    {
      key: 'kubeconfig',
      envVar: 'KODRA_KUBECONFIG',
      defaultRef: 'file',
      defaultFilePath: '/secrets/kubeconfig',
      required: false,
      defaultFor: ['compose'],
      // Optional inside the cluster (service account), required on Docker Compose.
      requiredOn: ['compose'],
      description:
        'Kubeconfig for the cluster. Not needed when the agent runs inside the cluster with its own service account.',
      howToCreate:
        'Create a kubeconfig for a service account bound to a namespace-scoped role. The Kubernetes bundle includes rbac.yaml with that role.',
      minimumScopes: {
        'read-only': [readRbac],
        'read-write-approved': [
          readRbac,
          'get and update on deployments/scale in the listed namespaces (scaling only, never the pod template)',
        ],
      },
      probe: 'kubernetes.list-pods',
      format: 'kubeconfig',
      steps: KUBECONFIG_STEPS,
    },
    // For EKS kubeconfigs that run `aws eks get-token` (the image has its own `aws` for that).
    // Their own variables (the AWS connector has AWS_*); the server gets them as AWS_*, over
    // any AWS_* it inherits from the agent's environment.
    {
      key: 'awsAccessKeyId',
      envVar: 'KODRA_K8S_AWS_ACCESS_KEY_ID',
      defaultRef: 'env',
      required: false,
      description:
        'AWS access key id, only for an EKS kubeconfig that signs in with aws eks get-token.',
      howToCreate:
        'Create an IAM user for the agent and map it to a view-only access policy in the cluster.',
      minimumScopes: { always: ['an EKS access entry with AmazonEKSViewPolicy on the namespaces'] },
      probe: 'kubernetes.list-pods',
      steps: EKS_KEY_STEPS,
    },
    {
      key: 'awsSecretAccessKey',
      envVar: 'KODRA_K8S_AWS_SECRET_ACCESS_KEY',
      defaultRef: 'env',
      required: false,
      description:
        'AWS secret access key, only for an EKS kubeconfig that signs in with aws eks get-token.',
      howToCreate: 'The secret key of the same IAM user.',
      minimumScopes: { always: ['an EKS access entry with AmazonEKSViewPolicy on the namespaces'] },
      probe: 'kubernetes.list-pods',
      steps: EKS_KEY_STEPS,
    },
  ],
  healthProbe: 'kubernetes.list-pods',
  // Every tool in the server's core toolset (v0.0.67). Only the allowlisted ones are exposed.
  tools: {
    events_list: 'read',
    pods_get: 'read',
    pods_list_in_namespace: 'read',
    pods_log: 'read',
    resources_get: 'read',
    resources_list: 'read',
    resources_scale: 'write',
    // Not exposed: cluster-wide reads that a namespace-scoped Role cannot serve.
    namespaces_list: 'read',
    nodes_log: 'read',
    nodes_stats_summary: 'read',
    nodes_top: 'read',
    pods_list: 'read',
    pods_top: 'read',
    projects_list: 'read',
    // Not exposed: arbitrary code, images, deletes, and free-form object changes.
    pods_exec: 'destructive',
    pods_run: 'destructive',
    pods_delete: 'destructive',
    resources_delete: 'destructive',
    resources_create_or_update: 'destructive',
  },
  guards: {
    events_list: inNamespace,
    pods_get: inNamespace,
    pods_list_in_namespace: inNamespace,
    pods_log: inNamespace,
    resources_get: inNamespace,
    resources_list: inNamespace,
    resources_scale: [...inNamespace, notSelf],
    pods_exec: [notSelf],
    pods_run: [notSelf],
    pods_delete: [notSelf],
    resources_delete: [notSelf],
    resources_create_or_update: [
      { kind: 'not-self', namespaceArg: 'namespace', resourceArg: 'resource' },
    ],
  },
  // A kubeconfig that is cluster-admin, reads Secrets, or changes deployments everywhere is
  // refused (M29): resources_get could hand Secrets to the model.
  credentialScope: 'kubernetes-rbac',
  // Scaling to zero or by more than half is destructive (M29).
  scaleLimit: {
    tool: 'resources_scale',
    replicasArg: 'scale',
    current: {
      tool: 'resources_get',
      copyArgs: ['apiVersion', 'kind', 'namespace', 'name'],
      path: ['spec', 'replicas'],
    },
  },
  // After an approved scale, watch until the pods are ready, else name the rollback (M29b).
  rolloutCheck: {
    tool: 'resources_scale',
    read: { tool: 'resources_get', copyArgs: ['apiVersion', 'kind', 'namespace', 'name'] },
    want: ['spec', 'replicas'],
    have: ['status', 'readyReplicas'],
    rollbackArg: 'scale',
    timeoutSeconds: 300,
  },
  // The console dashboard: read-only, per listed namespace (docs/console.md).
  dashboard: [
    {
      id: 'pods',
      title: 'Pods',
      tool: 'pods_list_in_namespace',
      forEach: { setting: 'namespaces', arg: 'namespace' },
      view: { kind: 'pods' },
    },
    {
      id: 'deployments',
      title: 'Deployments',
      tool: 'resources_list',
      args: { apiVersion: 'apps/v1', kind: 'Deployment' },
      forEach: { setting: 'namespaces', arg: 'namespace' },
      view: { kind: 'deployments' },
    },
    {
      id: 'warnings',
      title: 'Recent warnings',
      tool: 'events_list',
      forEach: { setting: 'namespaces', arg: 'namespace' },
      view: { kind: 'events' },
    },
    {
      // The pods of each listed database workload: ready, restarts, and status.
      id: 'databases',
      title: 'Database pods',
      tool: 'pods_list_in_namespace',
      forEach: { setting: 'databases', arg: 'namespace', scoped: true },
      view: { kind: 'workload' },
    },
  ],
  runtime: {
    type: 'mcp-stdio',
    source: {
      kind: 'github-release',
      repo: 'containers/kubernetes-mcp-server',
      version: 'v0.0.67',
      assets: {
        'linux-x64': {
          file: 'kubernetes-mcp-server-linux-amd64',
          sha256: 'd791c22b5367813cc9e7c66e405d8ff7f7d51189b5bd619fdd84a99cf7a1c116',
          archive: 'none',
          binary: 'kubernetes-mcp-server-linux-amd64',
        },
        'linux-arm64': {
          file: 'kubernetes-mcp-server-linux-arm64',
          sha256: 'd9378039b68b5247796655ba8bbb210d5e94287e56bd532112d81950a19f0e50',
          archive: 'none',
          binary: 'kubernetes-mcp-server-linux-arm64',
        },
        'darwin-arm64': {
          file: 'kubernetes-mcp-server-darwin-arm64',
          sha256: '9b383e365b8a4eab1f4acaa36818ed7e6bd6304b1b6a59b45427b35a357f233c',
          archive: 'none',
          binary: 'kubernetes-mcp-server-darwin-arm64',
        },
        'win32-x64': {
          file: 'kubernetes-mcp-server-windows-amd64.exe',
          sha256: 'e50462d6d7ebc7c34109321c60f571eb0940aea1f6f6da4b48b1166b72078a81',
          archive: 'none',
          binary: 'kubernetes-mcp-server-windows-amd64.exe',
        },
      },
    },
    args: ['--toolsets', 'core', '--disable-multi-cluster', '--stateless'],
    accessArgs: { 'read-only': ['--read-only'] },
    secretArgs: [
      {
        secret: 'kubeconfig',
        args: ['--kubeconfig', { secretFile: 'kubeconfig' }, '--cluster-provider', 'kubeconfig'],
      },
    ],
    env: {
      AWS_ACCESS_KEY_ID: { secret: 'awsAccessKeyId' },
      AWS_SECRET_ACCESS_KEY: { secret: 'awsSecretAccessKey' },
    },
    inheritEnv: [
      'KUBERNETES_SERVICE_HOST',
      'KUBERNETES_SERVICE_PORT',
      'KUBECONFIG',
      // For EKS kubeconfigs, whose exec plugin runs `aws eks get-token` (the agent image has
      // a built-in one). The values are registered with the redactor.
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
    ],
    configFile: { arg: '--config', content: SERVER_CONFIG },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      'Scales deployments in those namespaces after you approve.',
    ],
  },
});
