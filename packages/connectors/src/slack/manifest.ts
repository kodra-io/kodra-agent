import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';

export default defineManifest({
  id: 'slack',
  displayName: 'Slack',
  category: 'chat',
  status: 'available',
  description: t(
    'Talk to the agent and approve its actions in Slack. Uses Socket Mode, so no public endpoint is needed.',
    'تحدث مع الوكيل ووافق على إجراءاته في Slack. يستخدم Socket Mode، فلا حاجة إلى عنوان عام.',
  ),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'channel',
      required: true,
      description: t(
        'Channel for alerts, summaries, and approvals.',
        'القناة الخاصة بالتنبيهات والملخصات والموافقات.',
      ),
      pattern: PATTERNS.slackChannel,
      patternHint: t('start with #, like #payments-ops', 'ابدأ بالرمز #، مثل #payments-ops'),
      example: '#payments-ops',
    },
  ],
  secrets: [
    {
      key: 'botToken',
      envVar: 'SLACK_BOT_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t('Slack bot token. Starts with xoxb-.', 'رمز بوت Slack. يبدأ بـ xoxb-.'),
      howToCreate: t(
        'Create a Slack app from slack-app-manifest.yaml in the bundle (it turns on Socket Mode and sets the scopes below), then install it to your workspace. Copy the Bot User OAuth Token.',
        'أنشئ تطبيق Slack من الملف slack-app-manifest.yaml في الحزمة (يفعّل Socket Mode ويضبط الصلاحيات أدناه)، ثم ثبّته في مساحة العمل. انسخ Bot User OAuth Token.',
      ),
      minimumScopes: {
        // users:read resolves @name approvers to user ids at startup.
        always: [
          'app_mentions:read',
          'chat:write',
          'im:history',
          'im:read',
          'im:write',
          'users:read',
        ],
      },
      probe: 'slack.auth-test',
    },
    {
      key: 'appToken',
      envVar: 'SLACK_APP_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t(
        'Slack app-level token for Socket Mode. Starts with xapp-.',
        'رمز Slack على مستوى التطبيق لوضع Socket Mode. يبدأ بـ xapp-.',
      ),
      howToCreate: t(
        'In the same Slack app, open Basic Information > App-Level Tokens and create a token with the connections:write scope.',
        'في تطبيق Slack نفسه، افتح Basic Information ثم App-Level Tokens، وأنشئ رمزا بالصلاحية connections:write.',
      ),
      minimumScopes: { always: ['connections:write'] },
      probe: 'slack.open-socket-connection',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Posts in the configured channel and replies to mentions and direct messages.',
        'ينشر في القناة المحددة ويرد على الإشارات والرسائل المباشرة.',
      ),
      t(
        'Shows approval buttons for write actions. Only listed approvers can approve.',
        'يعرض أزرار الموافقة على إجراءات الكتابة. الموافقة متاحة فقط للمعتمدين المحددين.',
      ),
    ],
  },
});
