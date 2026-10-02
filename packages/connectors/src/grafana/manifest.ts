import { defineManifest } from '@kodra-agent/schema';
import { t } from '../shared.ts';

export default defineManifest({
  id: 'grafana',
  displayName: 'Grafana',
  category: 'monitoring',
  status: 'available',
  description: t(
    'Read dashboards, and logs from Loki through Grafana. Read-only.',
    'قراءة لوحات المعلومات وسجلات Loki عبر Grafana. للقراءة فقط.',
  ),
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: t('Grafana address.', 'عنوان Grafana.'),
      example: 'http://grafana.monitoring:3000',
    },
  ],
  secrets: [
    {
      key: 'serviceAccountToken',
      envVar: 'GRAFANA_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t('Grafana service account token.', 'رمز حساب الخدمة في Grafana.'),
      howToCreate: t(
        'In Grafana, open Administration > Users and access > Service accounts, add a service account with the Viewer role, and create a token for it.',
        'في Grafana، افتح Administration ثم Users and access ثم Service accounts، وأضف حساب خدمة بدور Viewer، ثم أنشئ له رمزا.',
      ),
      minimumScopes: { 'read-only': ['Viewer role'] },
      probe: 'grafana.get-current-org',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [
      t(
        'Reads dashboards, panels, and Loki logs through Grafana. Changes nothing.',
        'يقرأ لوحات المعلومات واللوحات الفرعية وسجلات Loki عبر Grafana. لا يغيّر شيئا.',
      ),
    ],
  },
});
