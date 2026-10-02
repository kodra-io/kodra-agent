import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const readSummary = t(
  'Reads pods, logs, events, deployments, and services in the listed namespaces only.',
  'يقرأ الحاويات والسجلات والأحداث وعمليات النشر والخدمات في مساحات الأسماء المحددة فقط.',
);

const readRbac =
  'get, list, watch on pods, pods/log, events, deployments, replicasets, services in the listed namespaces';

export default defineManifest({
  id: 'kubernetes',
  displayName: 'Kubernetes',
  category: 'deploy',
  status: 'available',
  description: t(
    'Inspect workloads in EKS, AKS, GKE, or on-prem clusters. With write access, restart or scale deployments.',
    'فحص أحمال العمل في EKS أو AKS أو GKE أو العناقيد المحلية. مع صلاحية الكتابة، إعادة تشغيل عمليات النشر أو تغيير حجمها.',
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
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Restarts or scales deployments in those namespaces after you approve.',
        'يعيد تشغيل عمليات النشر أو يغيّر حجمها في مساحات الأسماء تلك بعد موافقتك.',
      ),
    ],
  },
});
