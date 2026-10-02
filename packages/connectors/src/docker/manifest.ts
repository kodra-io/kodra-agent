import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

const readSummary = t(
  'Lists local images and containers and reads build logs.',
  'يعرض الصور والحاويات المحلية ويقرأ سجلات البناء.',
);

export default defineManifest({
  id: 'docker',
  displayName: 'Docker',
  category: 'build',
  status: 'available',
  description: t(
    'Inspect images and containers. With write access, build images for the ship flow.',
    'فحص الصور والحاويات. مع صلاحية الكتابة، بناء الصور لمسار الشحن.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'socketPath',
      required: true,
      description: t('Path to the Docker socket.', 'مسار مقبس Docker.'),
      pattern: PATTERNS.absolutePath,
      patternHint: t('must be an absolute path', 'يجب أن يكون مسارا مطلقا'),
      default: '/var/run/docker.sock',
    },
  ],
  secrets: [],
  healthProbe: 'docker.ping',
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Builds images through the Docker socket after you approve.',
        'يبني الصور عبر مقبس Docker بعد موافقتك.',
      ),
      t(
        'Docker socket access is close to full control of that machine. Enable it only on a machine meant for builds.',
        'الوصول إلى مقبس Docker يقارب التحكم الكامل بذلك الجهاز. فعّله فقط على جهاز مخصص للبناء.',
      ),
    ],
  },
});
