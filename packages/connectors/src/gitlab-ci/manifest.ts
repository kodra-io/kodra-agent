import { defineManifest } from '@kodra-agent/schema';
import { t } from '../shared.ts';

const readSummary = t(
  'Reads pipelines, jobs, and job logs with the GitLab token.',
  'يقرأ خطوط الإنتاج والمهام وسجلاتها باستخدام رمز GitLab.',
);

export default defineManifest({
  id: 'gitlab-ci',
  displayName: 'GitLab CI',
  category: 'cicd',
  status: 'available',
  description: t(
    'Read pipelines and job logs. With write access, propose pipeline changes through merge requests.',
    'قراءة خطوط الإنتاج وسجلات المهام. مع صلاحية الكتابة، اقتراح تغييرات خط الإنتاج عبر طلبات الدمج.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [
    {
      anyOf: [{ connector: 'gitlab' }],
      message: t(
        'GitLab CI needs the GitLab connector, because it uses the same token.',
        'يحتاج GitLab CI إلى موصل GitLab لأنه يستخدم الرمز نفسه.',
      ),
    },
  ],
  configFields: [],
  secrets: [],
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Proposes .gitlab-ci.yml changes through merge requests after you approve.',
        'يقترح تغييرات الملف .gitlab-ci.yml عبر طلبات الدمج بعد موافقتك.',
      ),
    ],
  },
});
