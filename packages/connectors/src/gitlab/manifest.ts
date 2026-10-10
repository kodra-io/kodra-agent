import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';
import { GITLAB_DENY_PATTERN, GITLAB_HIDDEN, GITLAB_SERVER } from './server.ts';

const readSummary = t(
  'Reads code, issues, and merge requests in the listed projects.',
  'يقرأ الشيفرة والمشكلات وطلبات الدمج في المشاريع المحددة.',
);

const inProjects: ToolGuard = {
  kind: 'repo-in-setting',
  repoArg: 'project_id',
  setting: 'projects',
};
const offDefault = (branchArg: string): ToolGuard => ({
  kind: 'not-default-branch',
  branchArg,
  repoArg: 'project_id',
});

const READ_TOOLS = [
  'get_project',
  'list_branches',
  'get_branch',
  'get_file_contents',
  'get_repository_tree',
  'list_commits',
  'get_commit',
  'get_commit_diff',
  'list_commit_statuses',
  'list_merge_requests',
  'get_merge_request',
  'get_merge_request_diffs',
  'list_merge_request_changed_files',
  'get_merge_request_notes',
  'list_issues',
  'get_issue',
  'list_issue_discussions',
] as const;

const WRITE_TOOLS = [
  'create_branch',
  'create_or_update_file',
  'create_merge_request',
  'update_merge_request',
  'create_merge_request_note',
  'create_issue',
  'update_issue',
  'create_issue_note',
] as const;

/** Can also delete and move files, so the server marks it destructive. */
const DESTRUCTIVE_TOOLS = ['push_files'] as const;

const EXPOSED = [...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS];

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
  // Only these tools are exposed; the rest of what the server offers is hidden (server.ts).
  tools: {
    ...Object.fromEntries(READ_TOOLS.map((name) => [name, 'read'])),
    ...Object.fromEntries(WRITE_TOOLS.map((name) => [name, 'write'])),
    ...Object.fromEntries(DESTRUCTIVE_TOOLS.map((name) => [name, 'destructive'])),
  },
  guards: {
    ...Object.fromEntries(EXPOSED.map((name) => [name, [inProjects]])),
    // Golden rule 6: commits and new branches never target the default branch.
    create_branch: [inProjects, offDefault('branch')],
    create_or_update_file: [inProjects, offDefault('branch')],
    push_files: [inProjects, offDefault('branch')],
    create_merge_request: [inProjects, offDefault('source_branch')],
  },
  hiddenTools: [...GITLAB_HIDDEN],
  defaultBranchLookup: 'gitlab',
  // Argument names checked against @zereight/mcp-gitlab 2.1.68's input schemas. push_files
  // is destructive here (it can delete and move files), so changes write files one by one.
  changeSteps: {
    create_branch: { kind: 'branch', repo: ['project_id'], branch: 'branch', from: 'ref' },
    create_or_update_file: {
      kind: 'file',
      repo: ['project_id'],
      branch: 'branch',
      path: 'file_path',
      content: 'content',
    },
    create_merge_request: {
      kind: 'pull-request',
      repo: ['project_id'],
      head: 'source_branch',
      base: 'target_branch',
      title: 'title',
    },
  },
  runtime: {
    type: 'mcp-stdio',
    source: GITLAB_SERVER,
    args: [],
    accessArgs: {
      'read-only': ['--permission-mode=readonly'],
      // modify: create and update, but no delete or teardown tools.
      'read-write-approved': ['--permission-mode=modify'],
    },
    env: {
      GITLAB_PERSONAL_ACCESS_TOKEN: { secret: 'token' },
      GITLAB_API_URL: { setting: 'url', suffix: '/api/v4' },
      GITLAB_DENIED_TOOLS_REGEX: { value: GITLAB_DENY_PATTERN },
      // No update check against the npm registry at startup: an outbound call nobody asked for.
      GITLAB_DISABLE_VERSION_CHECK: { value: 'true' },
    },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Creates branches and opens merge requests after you approve. Never pushes to the default branch and never merges.',
        'ينشئ فروعا ويفتح طلبات دمج بعد موافقتك. لا يدفع أبدا إلى الفرع الافتراضي ولا يدمج أبدا.',
      ),
    ],
  },
});
