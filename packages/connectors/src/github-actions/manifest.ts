import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { GITHUB_COMMON_ARGS, GITHUB_SERVER } from '../github/server.ts';

/** Runs only against the GitHub connector's repos. */
const inGithubRepos: ToolGuard[] = [
  { kind: 'repo-in-setting', ownerArg: 'owner', repoArg: 'repo', setting: 'repos', from: 'github' },
];

const readSummary =
  'Reads workflow runs and their logs with the GitHub token. Add Actions: read to that token.';

export default defineManifest({
  id: 'github-actions',
  displayName: 'GitHub Actions',
  category: 'cicd',
  status: 'available',
  description:
    'Read workflow runs and logs. With write access, propose pipeline changes through pull requests.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [
    {
      anyOf: [{ connector: 'github' }],
      message: 'GitHub Actions needs the GitHub connector, because it uses the same token.',
    },
  ],
  configFields: [],
  secrets: [],
  // The actions toolset (v1.13.0). Pipeline file changes go through the GitHub connector.
  tools: {
    actions_get: 'read',
    actions_list: 'read',
    get_job_logs: 'read',
    // Runs, reruns, or cancels workflows, which can deploy.
    actions_run_trigger: 'destructive',
  },
  guards: {
    actions_get: inGithubRepos,
    actions_list: inGithubRepos,
    get_job_logs: inGithubRepos,
    actions_run_trigger: inGithubRepos,
  },
  // The console dashboard: the latest workflow runs of each GitHub repo.
  dashboard: [
    {
      id: 'runs',
      title: 'Workflow runs',
      tool: 'actions_list',
      args: { method: 'list_workflow_runs', perPage: 20 },
      forEach: { setting: 'repos', from: 'github', arg: 'owner', repoArg: 'repo' },
      view: {
        kind: 'runs',
        items: 'workflow_runs',
        fields: {
          id: 'id',
          name: 'name',
          ref: 'head_branch',
          status: ['conclusion', 'status'],
          url: 'html_url',
          at: 'created_at',
        },
      },
    },
  ],
  runtime: {
    type: 'mcp-stdio',
    source: GITHUB_SERVER,
    args: [...GITHUB_COMMON_ARGS, '--toolsets', 'actions'],
    accessArgs: { 'read-only': ['--read-only'] },
    // The GitHub connector's token; add Actions: read to it (SPEC section 6).
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token', from: 'github' } },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      'Proposes workflow file changes through pull requests after you approve. Add Workflows: write to the GitHub token.',
    ],
  },
});
