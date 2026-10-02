import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const chainNote = t(
  'Leave both AWS keys empty to use the standard AWS credentials, such as an IAM role for the service account.',
  'اترك مفتاحي AWS فارغين لاستخدام بيانات اعتماد AWS المعتادة، مثل دور IAM لحساب الخدمة.',
);

const readPolicy = [
  'ecr:Describe*, ecr:List*',
  'eks:Describe*, eks:List*',
  'cloudwatch:Get*, cloudwatch:List*, cloudwatch:Describe*',
  'logs:Describe*, logs:Get*, logs:FilterLogEvents',
];

export default defineManifest({
  id: 'aws',
  displayName: 'AWS',
  category: 'cloud',
  status: 'available',
  description: t(
    'Read ECR images, EKS clusters, and CloudWatch metrics and logs. Read-only.',
    'قراءة صور ECR وعناقيد EKS ومقاييس CloudWatch وسجلاته. للقراءة فقط.',
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
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [
      t(
        'Reads ECR images, EKS clusters, and CloudWatch metrics and logs. Changes nothing.',
        'يقرأ صور ECR وعناقيد EKS ومقاييس CloudWatch وسجلاته. لا يغيّر شيئا.',
      ),
    ],
  },
});
