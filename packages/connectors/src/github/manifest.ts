import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const readSummary = t(
  'Reads code, issues, and pull requests in the listed repos.',
  'يقرأ الشيفرة والمشكلات وطلبات الدمج في المستودعات المحددة.',
);

export default defineManifest({
  id: 'github',
  displayName: 'GitHub',
  category: 'source',
  status: 'available',
  description: t(
    'Read repositories, issues, and pull requests. With write access, open branches and pull requests.',
    'قراءة المستودعات والمشكلات وطلبات الدمج. مع صلاحية الكتابة، إنشاء فروع وفتح طلبات دمج.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string-list',
      key: 'repos',
      required: true,
      description: t('Repositories the agent may use.', 'المستودعات التي يمكن للوكيل استخدامها.'),
      pattern: PATTERNS.githubRepo,
      patternHint: t(
        'use owner/repo, like acme/payments-api',
        'استخدم الصيغة owner/repo، مثل acme/payments-api',
      ),
      example: ['acme/payments-api'],
    },
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'GITHUB_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t(
        'GitHub token the agent uses for the repos above.',
        'رمز GitHub الذي يستخدمه الوكيل للمستودعات أعلاه.',
      ),
      howToCreate: t(
        'In GitHub, open Settings > Developer settings > Fine-grained personal access tokens and create a token limited to the repos above.',
        'في GitHub، افتح Settings ثم Developer settings ثم Fine-grained personal access tokens، وأنشئ رمزا يقتصر على المستودعات أعلاه.',
      ),
      minimumScopes: {
        'read-only': ['Metadata: read', 'Contents: read', 'Issues: read', 'Pull requests: read'],
        'read-write-approved': [
          'Metadata: read',
          'Contents: write',
          'Issues: read',
          'Pull requests: write',
        ],
      },
      probe: 'github.get-authenticated-user',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Creates branches and opens pull requests after you approve. Never pushes to the default branch.',
        'ينشئ فروعا ويفتح طلبات دمج بعد موافقتك. لا يدفع أبدا إلى الفرع الافتراضي.',
      ),
    ],
  },
});
