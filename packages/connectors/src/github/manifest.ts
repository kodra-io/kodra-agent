import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS } from '../shared.ts';
import { GITHUB_COMMON_ARGS, GITHUB_SERVER } from './server.ts';

const readSummary = 'Reads code, issues, and pull requests in the listed repos.';

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
  description:
    'Read repositories, issues, and pull requests. With write access, open branches and pull requests.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string-list',
      key: 'repos',
      required: true,
      description: 'Repositories the agent may use.',
      pattern: PATTERNS.githubRepo,
      patternHint: 'use owner/repo, like acme/payments-api',
      example: ['acme/payments-api'],
    },
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'GITHUB_TOKEN',
      defaultRef: 'env',
      required: true,
      description: 'GitHub token the agent uses for the repos above.',
      howToCreate:
        'In GitHub, open Settings > Developer settings > Fine-grained personal access tokens and create a token limited to the repos above.',
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
      steps: [
        {
          text: 'Open a new fine-grained token with the permissions filled in. Choose the owner of {{repos}} as Resource owner, then Only select repositories, and pick them. Add Actions: read for GitHub Actions.',
          link: 'https://github.com/settings/personal-access-tokens/new?name=kodra-agent&description=Kodra+AI+Agent&expires_in=366&metadata=read&contents=read&issues=read&pull_requests=read',
        },
        {
          text: 'For write access, use this one instead (Workflows: write too, if the agent should change workflow files):',
          link: 'https://github.com/settings/personal-access-tokens/new?name=kodra-agent&description=Kodra+AI+Agent&expires_in=366&metadata=read&contents=write&issues=write&pull_requests=write',
        },
        {
          text: 'Generate the token, copy it, and paste it here. It is tested before it is saved.',
        },
      ],
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
      'Creates branches and opens pull requests after you approve. Never pushes to the default branch and never merges.',
    ],
  },
});
