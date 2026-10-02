import { defineManifest } from '@kodra-agent/schema';
import { t } from '../shared.ts';

const readSummary = t(
  'Reads workflow runs and their logs with the GitHub token. Add Actions: read to that token.',
  'يقرأ تشغيلات سير العمل وسجلاتها باستخدام رمز GitHub. أضف الصلاحية Actions: read إلى ذلك الرمز.',
);

export default defineManifest({
  id: 'github-actions',
  displayName: 'GitHub Actions',
  category: 'cicd',
  status: 'available',
  description: t(
    'Read workflow runs and logs. With write access, propose pipeline changes through pull requests.',
    'قراءة تشغيلات سير العمل وسجلاتها. مع صلاحية الكتابة، اقتراح تغييرات خط الإنتاج عبر طلبات الدمج.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [
    {
      anyOf: [{ connector: 'github' }],
      message: t(
        'GitHub Actions needs the GitHub connector, because it uses the same token.',
        'يحتاج GitHub Actions إلى موصل GitHub لأنه يستخدم الرمز نفسه.',
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
        'Proposes workflow file changes through pull requests after you approve. Add Workflows: write to the GitHub token.',
        'يقترح تغييرات ملفات سير العمل عبر طلبات الدمج بعد موافقتك. أضف الصلاحية Workflows: write إلى رمز GitHub.',
      ),
    ],
  },
});
