import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS, t } from '../shared.ts';
import { GITHUB_COMMON_ARGS, GITHUB_SERVER } from './server.ts';

const readSummary = t(
  'Reads code, issues, and pull requests in the listed repos.',
  'يقرأ الشيفرة والمشكلات وطلبات الدمج في المستودعات المحددة.',
);

const inRepos: ToolGuard = {
  kind: 'repo-in-setting',
  ownerArg: 'owner',
  repoArg: 'repo',
  setting: 'repos',
};
const offDefault = (branchArg: string): ToolGuard => ({
  kind: 'not-default-branch',
  branchArg,
  ownerArg: 'owner',
  repoArg: 'repo',
});

const READ_TOOLS = [
  'get_commit',
  'get_file_contents',
  'get_label',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'issue_read',
  'list_branches',
  'list_commits',
  'list_issue_fields',
  'list_issue_types',
  'list_issues',
  'list_pull_requests',
  'list_releases',
  'list_repository_collaborators',
  'list_tags',
  'pull_request_read',
  'search_issues',
  'search_pull_requests',
] as const;

const WRITE_TOOLS = [
  'add_comment_to_pending_review',
  'add_issue_comment',
  'add_reply_to_pull_request_comment',
  'create_branch',
  'create_or_update_file',
  'create_pull_request',
  'issue_write',
  'push_files',
  'sub_issue_write',
  'update_issue_comment',
  'update_pull_request',
  'update_pull_request_branch',
] as const;

/** Never offered by the server: see docs/connectors/github.md. */
const EXCLUDED = [
  'merge_pull_request',
  'pull_request_review_write',
  'search_code',
  'search_commits',
  'search_repositories',
  'create_repository',
  'fork_repository',
];

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
          'Issues: write',
          'Pull requests: write',
        ],
      },
      probe: 'github.read-repos',
    },
  ],
  // Every tool in the repos, issues, and pull_requests toolsets (v1.13.0).
  tools: {
    ...Object.fromEntries(READ_TOOLS.map((name) => [name, 'read'])),
    ...Object.fromEntries(WRITE_TOOLS.map((name) => [name, 'write'])),
    delete_file: 'destructive',
    // Excluded at the server; classified so nothing is unclassified if a flag changes.
    merge_pull_request: 'destructive',
    pull_request_review_write: 'destructive',
    create_repository: 'destructive',
    fork_repository: 'destructive',
    search_code: 'read',
    search_commits: 'read',
    search_repositories: 'read',
  },
  guards: {
    ...Object.fromEntries(
      [...READ_TOOLS, ...WRITE_TOOLS, 'delete_file'].map((name) => [name, [inRepos]]),
    ),
    // Golden rule 6: commits and new branches never target the default branch.
    create_branch: [inRepos, offDefault('branch')],
    create_or_update_file: [inRepos, offDefault('branch')],
    push_files: [inRepos, offDefault('branch')],
    delete_file: [inRepos, offDefault('branch')],
    create_pull_request: [inRepos, offDefault('head')],
  },
  defaultBranchLookup: 'github',
  // Argument names checked against github-mcp-server v1.13.0's input schemas.
  changeSteps: {
    create_branch: {
      kind: 'branch',
      repo: ['owner', 'repo'],
      branch: 'branch',
      from: 'from_branch',
    },
    create_or_update_file: {
      kind: 'file',
      repo: ['owner', 'repo'],
      branch: 'branch',
      path: 'path',
      content: 'content',
    },
    push_files: {
      kind: 'files',
      repo: ['owner', 'repo'],
      branch: 'branch',
      files: 'files',
      path: 'path',
      content: 'content',
    },
    create_pull_request: {
      kind: 'pull-request',
      repo: ['owner', 'repo'],
      head: 'head',
      base: 'base',
      title: 'title',
    },
  },
  runtime: {
    type: 'mcp-stdio',
    source: GITHUB_SERVER,
    args: [
      ...GITHUB_COMMON_ARGS,
      '--toolsets',
      'repos,issues,pull_requests',
      '--exclude-tools',
      EXCLUDED.join(','),
    ],
    accessArgs: { 'read-only': ['--read-only'] },
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token' } },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Creates branches and opens pull requests after you approve. Never pushes to the default branch and never merges.',
        'ينشئ فروعا ويفتح طلبات دمج بعد موافقتك. لا يدفع أبدا إلى الفرع الافتراضي ولا يدمج أبدا.',
      ),
    ],
  },
});
