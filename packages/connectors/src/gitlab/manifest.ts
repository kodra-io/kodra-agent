import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const readSummary = t(
  'Reads code, issues, and merge requests in the listed projects.',
  'يقرأ الشيفرة والمشكلات وطلبات الدمج في المشاريع المحددة.',
);

export default defineManifest({
  id: 'gitlab',
  displayName: 'GitLab',
  category: 'source',
  status: 'available',
  description: t(
    'Read projects, issues, and merge requests. With write access, open branches and merge requests.',
    'قراءة المشاريع والمشكلات وطلبات الدمج. مع صلاحية الكتابة، إنشاء فروع وفتح طلبات دمج.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: t(
        'GitLab address. Change it for self-managed GitLab.',
        'عنوان GitLab. غيّره إذا كان GitLab مستضافا لديك.',
      ),
      default: 'https://gitlab.com',
    },
    {
      kind: 'string-list',
      key: 'projects',
      required: true,
      description: t('Projects the agent may use.', 'المشاريع التي يمكن للوكيل استخدامها.'),
      pattern: PATTERNS.gitlabProject,
      patternHint: t(
        'use group/project, like acme/payments-api',
        'استخدم الصيغة group/project، مثل acme/payments-api',
      ),
      example: ['acme/payments-api'],
    },
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'GITLAB_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t(
        'GitLab token the agent uses for the projects above.',
        'رمز GitLab الذي يستخدمه الوكيل للمشاريع أعلاه.',
      ),
      howToCreate: t(
        'In GitLab, create a personal, project, or group access token with the scopes below.',
        'في GitLab، أنشئ رمز وصول شخصيا أو خاصا بالمشروع أو بالمجموعة بالصلاحيات أدناه.',
      ),
      minimumScopes: {
        'read-only': ['read_api', 'read_repository'],
        'read-write-approved': ['api'],
      },
      probe: 'gitlab.read-projects',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Creates branches and opens merge requests after you approve. Never pushes to the default branch.',
        'ينشئ فروعا ويفتح طلبات دمج بعد موافقتك. لا يدفع أبدا إلى الفرع الافتراضي.',
      ),
    ],
  },
});
