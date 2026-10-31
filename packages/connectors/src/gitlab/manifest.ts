import { defineManifest, type Manifest, type ToolGuard } from '@kodra-agent/schema';
import { PATTERNS, pipelineFields } from '../shared.ts';
import {
  builtinRuntime,
  GITLAB_BUILTIN_HIDDEN,
  GITLAB_DENY_PATTERN,
  GITLAB_HIDDEN,
  GITLAB_SERVER,
  noUrl,
  SERVER_FIELD,
} from './server.ts';

const readSummary = 'Reads code, issues, and merge requests in the listed projects.';

const inProjects = (repoArg = 'project_id'): ToolGuard => ({
  kind: 'repo-in-setting',
  repoArg,
  setting: 'projects',
});
const offDefault = (branchArg: string): ToolGuard => ({
  kind: 'not-default-branch',
  branchArg,
  repoArg: 'project_id',
});
const noGroup: ToolGuard = {
  kind: 'arg-absent',
  arg: 'group_id',
  hint: 'only the listed projects, never a whole group; pass project_id',
};

// GitLab's built-in MCP server (GitLab 19.5+), with the core, merge_requests, work_items, and
// repository toolsets. Argument names checked against gitlab.com's server, 19.6.0-pre. Every
// call names one listed project with project_id (list_branches: id); `url` and `group_id`
// would name another project or a whole group, so they are refused.

/** Reads that take project_id, and url as another way to name the project. */
const BUILTIN_PROJECT_READS = [
  'get_project',
  'get_repository_file',
  'list_repository_tree',
  'list_commits',
  'get_commit',
  'list_tags',
  'list_releases',
  'get_merge_request',
] as const;

/** Reads that can also take a group instead of a project. */
const BUILTIN_GROUP_READS = [
  'list_merge_requests',
  'get_work_item',
  'list_work_items',
  'get_work_item_types',
] as const;

const builtin: Pick<Manifest, 'tools' | 'hiddenTools' | 'guards' | 'changeSteps'> = {
  tools: {
    get_mcp_server_version: 'read',
    ...Object.fromEntries(BUILTIN_PROJECT_READS.map((name) => [name, 'read'])),
    ...Object.fromEntries(BUILTIN_GROUP_READS.map((name) => [name, 'read'])),
    list_branches: 'read',
    list_project_members: 'read',
    add_branch: 'write',
    add_commit: 'write',
    save_merge_request: 'write',
    save_note: 'write',
    save_work_item: 'write',
  },
  hiddenTools: [...GITLAB_BUILTIN_HIDDEN],
  guards: {
    ...Object.fromEntries(BUILTIN_PROJECT_READS.map((name) => [name, [inProjects(), noUrl]])),
    ...Object.fromEntries(
      BUILTIN_GROUP_READS.map((name) => [name, [inProjects(), noUrl, noGroup]]),
    ),
    list_branches: [inProjects('id')],
    list_project_members: [inProjects()],
    // Golden rule 6: new branches and commits never target the default branch.
    add_branch: [inProjects(), noUrl, offDefault('branch')],
    add_commit: [
      inProjects(),
      noUrl,
      offDefault('branch'),
      {
        kind: 'arg-absent',
        arg: 'start_project',
        hint: 'commits start from the same project',
      },
      // Creates and updates whole files, so the preview shows the exact change. Deleting,
      // moving, and in-place text replacement are refused.
      {
        kind: 'items-allowed',
        arg: 'actions',
        field: 'action',
        allowed: ['create', 'update'],
        forbid: ['old_str', 'new_str', 'previous_path', 'encoding'],
      },
    ],
    // Opens a merge request from a new branch; updating one needs its source branch too.
    save_merge_request: [
      inProjects(),
      offDefault('source_branch'),
      {
        kind: 'arg-absent',
        arg: 'target_project_id',
        hint: 'merge requests stay in the same project',
      },
    ],
    save_note: [inProjects(), noUrl, noGroup],
    save_work_item: [inProjects(), noUrl, noGroup],
  },
  changeSteps: {
    add_branch: { kind: 'branch', repo: ['project_id'], branch: 'branch', from: 'ref' },
    add_commit: {
      kind: 'files',
      repo: ['project_id'],
      branch: 'branch',
      files: 'actions',
      path: 'file_path',
      content: 'content',
    },
    save_merge_request: {
      kind: 'pull-request',
      repo: ['project_id'],
      head: 'source_branch',
      base: 'target_branch',
      title: 'title',
      body: 'description',
    },
  },
};

// The community server, @zereight/mcp-gitlab, for GitLab older than 19.5 (server: community).

const COMMUNITY_READS = [
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

const COMMUNITY_WRITES = [
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
const COMMUNITY_DESTRUCTIVE = ['push_files'] as const;

const COMMUNITY_EXPOSED = [...COMMUNITY_READS, ...COMMUNITY_WRITES, ...COMMUNITY_DESTRUCTIVE];

export default defineManifest({
  id: 'gitlab',
  displayName: 'GitLab',
  category: 'source',
  status: 'available',
  description:
    'Read projects, issues, and merge requests. With write access, open branches and merge requests.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: 'GitLab address. Change it for self-managed GitLab.',
      default: 'https://gitlab.com',
    },
    {
      kind: 'string-list',
      key: 'projects',
      required: true,
      description: 'Projects the agent may use.',
      pattern: PATTERNS.gitlabProject,
      patternHint: 'use group/project, like acme/payments-api',
      example: ['acme/payments-api'],
    },
    SERVER_FIELD,
    ...pipelineFields('gitlab'),
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'GITLAB_TOKEN',
      defaultRef: 'env',
      required: true,
      description: 'GitLab token the agent uses for the projects above.',
      howToCreate:
        "For GitLab's built-in MCP server, create a fine-grained personal access token with the MCP server permission and access to the projects above. For the community server (older GitLab), a personal, project, or group access token with the scopes below works.",
      minimumScopes: {
        'read-only': [
          'built-in server: MCP server (Execute), and read access to the repository and API of the projects',
          'community server: read_api, read_repository',
        ],
        'read-write-approved': [
          'built-in server: MCP server (Execute), and write access to the repository and merge requests of the projects',
          'community server: api',
        ],
      },
      probe: 'gitlab.read-projects',
      steps: [
        {
          text: "GitLab's built-in MCP server needs GitLab 19.5 or newer, and an administrator (or the top-level group's Owner) must turn on Allow access to the MCP server.",
        },
        {
          text: 'Open your access tokens and add a fine-grained token: give it the MCP server permission and access to {{projects}}, with write access to their repository and merge requests for write access.',
          link: '{{url}}/-/user_settings/personal_access_tokens',
        },
        {
          text: 'On older GitLab, set server to community, and open a personal access token with read access filled in instead. A project or group access token on {{projects}} works too, and is narrower. For write access, use the api scope.',
          link: '{{url}}/-/user_settings/personal_access_tokens?name=kodra-agent&description=Kodra+AI+Agent&scopes=read_api,read_repository',
        },
        { text: 'Create the token, copy it, and paste it here. It is tested before it is saved.' },
      ],
    },
  ],
  ...builtin,
  defaultBranchLookup: 'gitlab',
  runtime: builtinRuntime('core,merge_requests,work_items,repository'),
  variants: {
    setting: 'server',
    options: {
      community: {
        // Only these tools are exposed; the rest of what the server offers is hidden (server.ts).
        tools: {
          ...Object.fromEntries(COMMUNITY_READS.map((name) => [name, 'read'])),
          ...Object.fromEntries(COMMUNITY_WRITES.map((name) => [name, 'write'])),
          ...Object.fromEntries(COMMUNITY_DESTRUCTIVE.map((name) => [name, 'destructive'])),
        },
        guards: {
          ...Object.fromEntries(COMMUNITY_EXPOSED.map((name) => [name, [inProjects()]])),
          // Golden rule 6: commits and new branches never target the default branch.
          create_branch: [inProjects(), offDefault('branch')],
          create_or_update_file: [inProjects(), offDefault('branch')],
          push_files: [inProjects(), offDefault('branch')],
          create_merge_request: [inProjects(), offDefault('source_branch')],
        },
        hiddenTools: [...GITLAB_HIDDEN],
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
            body: 'description',
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
      },
    },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      'Creates branches and opens merge requests after you approve. Never pushes to the default branch and never merges.',
    ],
  },
});
