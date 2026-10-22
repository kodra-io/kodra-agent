import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { GITLAB_CI_HIDDEN, GITLAB_DENY_PATTERN, GITLAB_SERVER } from '../gitlab/server.ts';

/** Runs only against the GitLab connector's projects. */
const inGitlabProjects: ToolGuard[] = [
  { kind: 'repo-in-setting', repoArg: 'project_id', setting: 'projects', from: 'gitlab' },
];

const READ_TOOLS = [
  'list_pipelines',
  'get_pipeline',
  'list_pipeline_jobs',
  'get_pipeline_job',
  'get_pipeline_job_output',
  'get_pipeline_test_report_summary',
] as const;

/** Starting or retrying pipelines and jobs can deploy. */
const DESTRUCTIVE_TOOLS = [
  'create_pipeline',
  'retry_pipeline',
  'retry_pipeline_job',
  'play_pipeline_job',
] as const;

const EXPOSED = [...READ_TOOLS, ...DESTRUCTIVE_TOOLS];

const readSummary = 'Reads pipelines, jobs, and job logs with the GitLab token.';

export default defineManifest({
  id: 'gitlab-ci',
  displayName: 'GitLab CI',
  category: 'cicd',
  status: 'available',
  description:
    'Read pipelines and job logs. With write access, propose pipeline changes through merge requests.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [
    {
      anyOf: [{ connector: 'gitlab' }],
      message: 'GitLab CI needs the GitLab connector, because it uses the same token.',
    },
  ],
  configFields: [],
  secrets: [],
  // Only these pipeline tools are exposed. Never exposed: get_pipeline_variables and
  // get_pipeline_schedule_variable, which return CI/CD variable values (often secrets).
  tools: {
    ...Object.fromEntries(READ_TOOLS.map((name) => [name, 'read'])),
    ...Object.fromEntries(DESTRUCTIVE_TOOLS.map((name) => [name, 'destructive'])),
  },
  guards: Object.fromEntries(EXPOSED.map((name) => [name, inGitlabProjects])),
  hiddenTools: [...GITLAB_CI_HIDDEN],
  // The console dashboard: the latest pipelines of each GitLab project.
  dashboard: [
    {
      id: 'pipelines',
      title: 'Pipelines',
      tool: 'list_pipelines',
      args: { per_page: 20 },
      forEach: { setting: 'projects', from: 'gitlab', arg: 'project_id' },
      view: {
        kind: 'runs',
        fields: { id: 'id', ref: 'ref', status: ['status'], url: 'web_url', at: 'created_at' },
      },
    },
  ],
  runtime: {
    type: 'mcp-stdio',
    source: GITLAB_SERVER,
    args: [],
    accessArgs: {
      'read-only': ['--permission-mode=readonly'],
      'read-write-approved': ['--permission-mode=modify'],
    },
    // The GitLab connector's token and address.
    env: {
      GITLAB_PERSONAL_ACCESS_TOKEN: { secret: 'token', from: 'gitlab' },
      GITLAB_API_URL: { setting: 'url', suffix: '/api/v4', from: 'gitlab' },
      GITLAB_TOOLSETS: { value: 'pipelines' },
      GITLAB_DENIED_TOOLS_REGEX: { value: GITLAB_DENY_PATTERN },
      // No update check against the npm registry at startup: an outbound call nobody asked for.
      GITLAB_DISABLE_VERSION_CHECK: { value: 'true' },
    },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      'Proposes .gitlab-ci.yml changes through merge requests after you approve.',
    ],
  },
});
