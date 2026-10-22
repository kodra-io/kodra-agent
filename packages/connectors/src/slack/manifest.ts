import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS } from '../shared.ts';

export default defineManifest({
  id: 'slack',
  displayName: 'Slack',
  category: 'chat',
  status: 'available',
  description:
    'Talk to the agent and approve its actions in Slack. Uses Socket Mode, so no public endpoint is needed.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'channel',
      required: true,
      description: 'Channel for alerts, summaries, and approvals.',
      pattern: PATTERNS.slackChannel,
      patternHint: 'start with #, like #payments-ops',
      example: '#payments-ops',
    },
  ],
  secrets: [
    {
      key: 'botToken',
      envVar: 'SLACK_BOT_TOKEN',
      defaultRef: 'env',
      required: true,
      description: 'Slack bot token. Starts with xoxb-.',
      howToCreate:
        'Create a Slack app from slack-app-manifest.yaml in the bundle (it turns on Socket Mode and sets the scopes below), then install it to your workspace. Copy the Bot User OAuth Token.',
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
      description: 'Slack app-level token for Socket Mode. Starts with xapp-.',
      howToCreate:
        'In the same Slack app, open Basic Information > App-Level Tokens and create a token with the connections:write scope.',
      minimumScopes: { always: ['connections:write'] },
      probe: 'slack.open-socket-connection',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      'Posts in the configured channel and replies to mentions and direct messages.',
      'Shows approval buttons for write actions. Only listed approvers can approve.',
    ],
  },
});
