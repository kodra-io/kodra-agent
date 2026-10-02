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
  // Every tool in the enabled categories (v2.0.0). --disable-write hides the write ones.
  tools: {
    alerting_manage_routing: 'read',
    alerting_rules_read: 'read',
    alerting_silences_read: 'read',
    analyze_loki_labels: 'read',
    check_datasources_health: 'read',
    get_dashboard_by_uid: 'read',
    get_dashboard_panel_queries: 'read',
    get_dashboard_property: 'read',
    get_dashboard_summary: 'read',
    get_datasource: 'read',
    list_dashboard_versions: 'read',
    list_datasources: 'read',
    list_loki_label_names: 'read',
    list_loki_label_values: 'read',
    list_prometheus_label_names: 'read',
    list_prometheus_label_values: 'read',
    list_prometheus_metric_metadata: 'read',
    list_prometheus_metric_names: 'read',
    query_loki_logs: 'read',
    query_loki_patterns: 'read',
    query_loki_stats: 'read',
    query_prometheus: 'read',
    query_prometheus_histogram: 'read',
    search_dashboards: 'read',
    search_folders: 'read',
    // Hidden by --disable-write; listed so nothing is unclassified.
    alerting_routing_write: 'write',
    alerting_rules_write: 'write',
    alerting_silences_write: 'write',
    update_dashboard: 'write',
    create_datasource: 'destructive',
    update_datasource: 'destructive',
  },
  runtime: {
    type: 'mcp-stdio',
    source: {
      kind: 'github-release',
      repo: 'grafana/mcp-grafana',
      version: 'v2.0.0',
      assets: {
        'linux-x64': {
          file: 'mcp-grafana_Linux_x86_64.tar.gz',
          sha256: '0a0dde2c882c24fedcce79a07d97b232f71730c744b84a09b6b0735c2ca3d024',
          archive: 'tar.gz',
          binary: 'mcp-grafana',
        },
        'linux-arm64': {
          file: 'mcp-grafana_Linux_arm64.tar.gz',
          sha256: '5b29581cad5ce21a0db67c655e5e7e71a9163b4e1ba1b518559baa3c54133a28',
          archive: 'tar.gz',
          binary: 'mcp-grafana',
        },
        'darwin-arm64': {
          file: 'mcp-grafana_Darwin_arm64.tar.gz',
          sha256: 'eb4f0dab9fee524d7bc73aaffae42efc4539aea046f2628353a9824e27167dd3',
          archive: 'tar.gz',
          binary: 'mcp-grafana',
        },
        'win32-x64': {
          file: 'mcp-grafana_Windows_x86_64.zip',
          sha256: 'f95a37d9eb84c67cba659cd7f79ac76c3072fb166b6cf979eb86757bd6e0d18f',
          archive: 'zip',
          binary: 'mcp-grafana.exe',
        },
      },
    },
    // v2.0.0 turned anonymous usage reporting on by default; it stays off (golden rule 7).
    args: [
      '--usage-stats=disabled',
      '--disable-write',
      '--enabled-tools',
      'search,datasource,prometheus,loki,alerting,dashboard',
    ],
    env: {
      GRAFANA_URL: { setting: 'url' },
      GRAFANA_SERVICE_ACCOUNT_TOKEN: { secret: 'serviceAccountToken' },
      GRAFANA_USAGE_STATS: { value: 'disabled' },
      DO_NOT_TRACK: { value: '1' },
    },
  },
  permissionsSummary: {
    'read-only': [
      t(
        'Reads dashboards, panels, and Loki logs through Grafana. Changes nothing.',
        'يقرأ لوحات المعلومات واللوحات الفرعية وسجلات Loki عبر Grafana. لا يغيّر شيئا.',
      ),
    ],
  },
});
