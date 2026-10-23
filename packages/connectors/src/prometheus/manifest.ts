import { defineManifest } from '@kodra-agent/schema';

export default defineManifest({
  id: 'prometheus',
  displayName: 'Prometheus',
  category: 'monitoring',
  status: 'available',
  description: 'Query metrics and watch firing alerts. Read-only.',
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: 'Prometheus address.',
      example: 'http://prometheus.monitoring:9090',
    },
    {
      kind: 'url',
      key: 'alertmanagerUrl',
      required: false,
      description: 'Alertmanager address. Leave empty to read alerts from Prometheus.',
      example: 'http://alertmanager.monitoring:9093',
    },
    {
      kind: 'integer',
      key: 'pollIntervalSeconds',
      required: true,
      description: 'How often to check for firing alerts, in seconds.',
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
      description: 'Bearer token, only if your Prometheus requires one.',
      howToCreate:
        'Use a token from whatever protects your Prometheus, such as a proxy. It only needs read access.',
      minimumScopes: { 'read-only': ['read access to the query and alerts APIs'] },
      probe: 'prometheus.query-up',
      steps: [
        {
          text: 'Only if something in front of Prometheus asks for a token, such as a proxy: create one there that can read the query and alerts APIs, and paste it here. Leave it empty otherwise.',
        },
      ],
    },
  ],
  healthProbe: 'prometheus.query-up',
  tools: {
    execute_query: 'read',
    execute_range_query: 'read',
    get_metric_metadata: 'read',
    get_targets: 'read',
    health_check: 'read',
    list_metrics: 'read',
  },
  runtime: {
    type: 'mcp-stdio',
    // Runs with uvx. M7 installs it from a locked environment; see docs/connectors/prometheus.md.
    source: {
      kind: 'pypi',
      package: 'prometheus-mcp-server',
      version: '1.6.2',
      command: 'prometheus-mcp-server',
    },
    args: [],
    env: {
      PROMETHEUS_URL: { setting: 'url' },
      PROMETHEUS_TOKEN: { secret: 'bearerToken' },
      PROMETHEUS_DISABLE_LINKS: { value: 'True' },
      PROMETHEUS_MCP_SERVER_TRANSPORT: { value: 'stdio' },
    },
  },
  permissionsSummary: {
    'read-only': [
      'Runs read-only queries and reads firing alerts. Checks for new alerts at the poll interval.',
    ],
  },
});
