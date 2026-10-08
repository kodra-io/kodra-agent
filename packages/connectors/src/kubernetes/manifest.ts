import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const readSummary = t(
  'Reads pods, logs, events, deployments, and services in the listed namespaces only. Never reads Secrets.',
  'يقرأ الحاويات والسجلات والأحداث وعمليات النشر والخدمات في مساحات الأسماء المحددة فقط. لا يقرأ الأسرار أبدا.',
);

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

const inNamespace: ToolGuard[] = [
  { kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: true },
];

export default defineManifest({
  id: 'kubernetes',
  displayName: 'Kubernetes',
  category: 'deploy',
  status: 'available',
  description: t(
    'Inspect workloads in EKS, AKS, GKE, or on-prem clusters. With write access, scale deployments.',
    'فحص أحمال العمل في EKS أو AKS أو GKE أو العناقيد المحلية. مع صلاحية الكتابة، تغيير حجم عمليات النشر.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string-list',
      key: 'namespaces',
      required: true,
      description: t(
        'Namespaces the agent may access. Nothing outside them.',
        'مساحات الأسماء التي يمكن للوكيل الوصول إليها، ولا شيء خارجها.',
      ),
      pattern: PATTERNS.k8sNamespace,
      patternHint: t(
        'use a Kubernetes namespace name: lowercase letters, digits, and hyphens',
        'استخدم اسم مساحة أسماء صالحا: أحرف صغيرة وأرقام وشرطات',
      ),
      example: ['payments'],
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
      description: t(
        'Kubeconfig for the cluster. Not needed when the agent runs inside the cluster with its own service account.',
        'ملف kubeconfig للعنقود. لا حاجة إليه عندما يعمل الوكيل داخل العنقود بحساب الخدمة الخاص به.',
      ),
      howToCreate: t(
        'Create a kubeconfig for a service account bound to a namespace-scoped role. The Kubernetes bundle includes rbac.yaml with that role.',
        'أنشئ ملف kubeconfig لحساب خدمة مرتبط بدور محصور في مساحات الأسماء. حزمة Kubernetes تتضمن الملف rbac.yaml بهذا الدور.',
      ),
      minimumScopes: {
        'read-only': [readRbac],
        'read-write-approved': [
          readRbac,
          'patch on deployments and deployments/scale in the listed namespaces',
        ],
      },
      probe: 'kubernetes.list-pods',
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
    resources_scale: inNamespace,
  },
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
    env: {},
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
      t(
        'Scales deployments in those namespaces after you approve.',
        'يغيّر حجم عمليات النشر في مساحات الأسماء تلك بعد موافقتك.',
      ),
    ],
  },
});
