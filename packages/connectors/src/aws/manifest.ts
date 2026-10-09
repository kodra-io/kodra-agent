import { defineManifest, type McpStdioRuntime } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const chainNote = t(
  'Leave both AWS keys empty to use the standard AWS credentials, such as an IAM role for the service account.',
  'اترك مفتاحي AWS فارغين لاستخدام بيانات اعتماد AWS المعتادة، مثل دور IAM لحساب الخدمة.',
);

const readPolicy = [
  'eks:Describe*, eks:List*',
  'cloudwatch:Get*, cloudwatch:List*, cloudwatch:Describe*',
  'logs:Describe*, logs:Get*, logs:FilterLogEvents, logs:StartQuery, logs:GetQueryResults',
];

/** Both AWS Labs servers get the same credentials: the connector's keys or the default chain. */
const awsEnv: McpStdioRuntime['env'] = {
  AWS_REGION: { setting: 'region' },
  AWS_ACCESS_KEY_ID: { secret: 'accessKeyId' },
  AWS_SECRET_ACCESS_KEY: { secret: 'secretAccessKey' },
  FASTMCP_LOG_LEVEL: { value: 'ERROR' },
};

/** IAM roles for service accounts (IRSA), container credentials, and profiles. */
const awsInheritEnv = [
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_PROFILE',
  'AWS_STS_REGIONAL_ENDPOINTS',
];

export default defineManifest({
  id: 'aws',
  displayName: 'AWS',
  category: 'cloud',
  status: 'available',
  description: t(
    'Read EKS clusters and CloudWatch metrics, logs, and alarms. Read-only.',
    'قراءة عناقيد EKS ومقاييس CloudWatch وسجلاته وتنبيهاته. للقراءة فقط.',
  ),
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'region',
      required: true,
      description: t('AWS region.', 'منطقة AWS.'),
      pattern: PATTERNS.awsRegion,
      patternHint: t('use an AWS region, like eu-central-1', 'استخدم منطقة AWS، مثل eu-central-1'),
      example: 'eu-central-1',
    },
    {
      kind: 'string-list',
      key: 'services',
      required: false,
      description: t(
        'AWS services the agent can read: eks, cloudwatch. Each one adds tools the model reads on every question, so leave out what you do not need.',
        'خدمات AWS التي يمكن للوكيل قراءتها: eks و cloudwatch. كل خدمة تضيف أدوات يقرؤها النموذج مع كل سؤال، فاترك ما لا تحتاجه.',
      ),
      pattern: '^(eks|cloudwatch)$',
      patternHint: t('use eks or cloudwatch', 'استخدم eks أو cloudwatch'),
      default: ['eks', 'cloudwatch'],
      example: ['eks'],
    },
  ],
  secrets: [
    {
      key: 'accessKeyId',
      envVar: 'AWS_ACCESS_KEY_ID',
      defaultRef: 'env',
      required: false,
      defaultFor: ['compose'],
      description: t('AWS access key id.', 'معرّف مفتاح الوصول في AWS.'),
      howToCreate: chainNote,
      minimumScopes: { 'read-only': readPolicy },
      probe: 'aws.get-caller-identity',
    },
    {
      key: 'secretAccessKey',
      envVar: 'AWS_SECRET_ACCESS_KEY',
      defaultRef: 'env',
      required: false,
      defaultFor: ['compose'],
      description: t('AWS secret access key.', 'مفتاح الوصول السري في AWS.'),
      howToCreate: chainNote,
      minimumScopes: { 'read-only': readPolicy },
      probe: 'aws.get-caller-identity',
    },
  ],
  healthProbe: 'aws.get-caller-identity',
  tools: {
    // awslabs.eks-mcp-server 0.2.1
    get_cloudwatch_logs: 'read',
    get_cloudwatch_metrics: 'read',
    get_eks_insights: 'read',
    get_eks_metrics_guidance: 'read',
    get_eks_vpc_config: 'read',
    get_policies_for_role: 'read',
    list_api_versions: 'read',
    search_eks_troubleshoot_guide: 'read',
    // Offered even without --allow-write; the server refuses them, and policy blocks them.
    add_inline_policy: 'destructive',
    apply_yaml: 'destructive',
    generate_app_manifest: 'destructive',
    manage_eks_stacks: 'destructive',
    manage_k8s_resource: 'destructive',
    // awslabs.cloudwatch-mcp-server 0.3.1
    analyze_log_group: 'read',
    analyze_metric: 'read',
    describe_log_groups: 'read',
    execute_cwl_insights_batch: 'read',
    execute_log_insights_query: 'read',
    execute_promql_query: 'read',
    execute_promql_range_query: 'read',
    get_active_alarms: 'read',
    get_alarm_history: 'read',
    get_logs_insight_query_results: 'read',
    get_metric_data: 'read',
    get_metric_metadata: 'read',
    get_promql_label_values: 'read',
    get_promql_labels: 'read',
    get_promql_series: 'read',
    get_recommended_metric_alarms: 'read',
    recommend_indexes_account: 'read',
    recommend_indexes_loggroup: 'read',
    cancel_logs_insight_query: 'write',
  },
  // Pod-level access through AWS credentials would bypass the Kubernetes connector's
  // namespace limits; the Kubernetes connector covers pods instead.
  hiddenTools: ['get_k8s_events', 'get_pod_logs', 'list_k8s_resources'],
  runtime: [
    {
      type: 'mcp-stdio',
      name: 'eks',
      source: {
        kind: 'pypi',
        package: 'awslabs.eks-mcp-server',
        version: '0.2.1',
        command: 'awslabs.eks-mcp-server',
      },
      args: ['--no-allow-write', '--no-allow-sensitive-data-access'],
      env: awsEnv,
      inheritEnv: awsInheritEnv,
      onlyIf: { setting: 'services', includes: 'eks' },
    },
    {
      type: 'mcp-stdio',
      name: 'cloudwatch',
      source: {
        kind: 'pypi',
        package: 'awslabs.cloudwatch-mcp-server',
        version: '0.3.1',
        command: 'awslabs.cloudwatch-mcp-server',
      },
      args: [],
      env: awsEnv,
      inheritEnv: awsInheritEnv,
      onlyIf: { setting: 'services', includes: 'cloudwatch' },
    },
  ],
  permissionsSummary: {
    'read-only': [
      t(
        'Reads EKS clusters and CloudWatch metrics, logs, and alarms. Changes nothing.',
        'يقرأ عناقيد EKS ومقاييس CloudWatch وسجلاته وتنبيهاته. لا يغيّر شيئا.',
      ),
      t(
        'CloudWatch Logs Insights queries are billed by AWS for the data they scan.',
        'تفرض AWS رسوما على استعلامات CloudWatch Logs Insights حسب حجم البيانات التي تفحصها.',
      ),
    ],
  },
});
