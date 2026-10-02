import { defineManifest } from '@kodra-agent/schema';
import { t } from '../shared.ts';

export default defineManifest({
  id: 'prometheus',
  displayName: 'Prometheus',
  category: 'monitoring',
  status: 'available',
  description: t(
    'Query metrics and watch firing alerts. Read-only.',
    'الاستعلام عن المقاييس ومراقبة التنبيهات النشطة. للقراءة فقط.',
  ),
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: t('Prometheus address.', 'عنوان Prometheus.'),
      example: 'http://prometheus.monitoring:9090',
    },
    {
      kind: 'url',
      key: 'alertmanagerUrl',
      required: false,
      description: t(
        'Alertmanager address. Leave empty to read alerts from Prometheus.',
        'عنوان Alertmanager. اتركه فارغا لقراءة التنبيهات من Prometheus.',
      ),
      example: 'http://alertmanager.monitoring:9093',
    },
    {
      kind: 'integer',
      key: 'pollIntervalSeconds',
      required: true,
      description: t(
        'How often to check for firing alerts, in seconds.',
        'عدد الثواني بين كل فحص للتنبيهات النشطة.',
      ),
      min: 15,
      max: 3600,
      default: 60,
    },
  ],
  secrets: [
    {
      key: 'bearerToken',
      envVar: 'PROMETHEUS_TOKEN',
      defaultRef: 'env',
      required: false,
      description: t(
        'Bearer token, only if your Prometheus requires one.',
        'رمز Bearer، فقط إذا كان Prometheus لديك يتطلبه.',
      ),
      howToCreate: t(
        'Use a token from whatever protects your Prometheus, such as a proxy. It only needs read access.',
        'استخدم رمزا من الجهة التي تحمي Prometheus لديك، مثل خادم وسيط. يحتاج إلى صلاحية القراءة فقط.',
      ),
      minimumScopes: { 'read-only': ['read access to the query and alerts APIs'] },
      probe: 'prometheus.query-up',
    },
  ],
  healthProbe: 'prometheus.query-up',
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [
      t(
        'Runs read-only queries and reads firing alerts. Checks for new alerts at the poll interval.',
        'ينفذ استعلامات للقراءة فقط ويقرأ التنبيهات النشطة. يفحص التنبيهات الجديدة في كل فترة فحص.',
      ),
    ],
  },
});
