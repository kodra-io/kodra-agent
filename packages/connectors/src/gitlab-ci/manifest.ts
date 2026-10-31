import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import {
  builtinRuntime,
  GITLAB_CI_HIDDEN,
  GITLAB_DENY_PATTERN,
  GITLAB_SERVER,
  noUrl,
} from '../gitlab/server.ts';

/** Runs only against the GitLab connector's projects. */
const inGitlabProjects = (repoArg: string): ToolGuard => ({
  kind: 'repo-in-setting',
  repoArg,
  setting: 'projects',
  from: 'gitlab',
});

// GitLab's built-in MCP server, ci toolset (argument names from gitlab.com, 19.6.0-pre).
// list_pipelines, get_pipeline, and get_job name the project with `id`.
const BUILTIN_ID_READS = ['list_pipelines', 'get_pipeline', 'get_job'] as const;

// The community server, @zereight/mcp-gitlab (server: community on the GitLab connector).
const COMMUNITY_READS = [
  'list_pipelines',
  'get_pipeline',
  'list_pipeline_jobs',
  'get_pipeline_job',
  'get_pipeline_job_output',
  'get_pipeline_test_report_summary',
] as const;

/** Starting or retrying pipelines and jobs can deploy. */
const COMMUNITY_DESTRUCTIVE = [
  'create_pipeline',
  'retry_pipeline',
  'retry_pipeline_job',
  'play_pipeline_job',
] as const;

const COMMUNITY_EXPOSED = [...COMMUNITY_READS, ...COMMUNITY_DESTRUCTIVE];

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
  // Never exposed by either server: CI/CD variable values (often secrets).
  tools: {
    get_mcp_server_version: 'read',
    ...Object.fromEntries(BUILTIN_ID_READS.map((name) => [name, 'read'])),
    get_artifact_file: 'read',
    // Runs a new pipeline, which can deploy. Retrying or cancelling one names it by its
    // global id, which no project check can scope, so pipeline_id is refused.
    save_pipeline: 'destructive',
  },
  hiddenTools: ['manage_pipeline', 'get_pipeline_jobs'],
  guards: {
    ...Object.fromEntries(BUILTIN_ID_READS.map((name) => [name, [inGitlabProjects('id')]])),
    get_artifact_file: [inGitlabProjects('project_id'), noUrl],
    save_pipeline: [
      inGitlabProjects('project_id'),
      noUrl,
      {
        kind: 'arg-absent',
        arg: 'pipeline_id',
        hint: 'only new pipelines, on a listed project; an existing pipeline is named by an id no project check covers',
      },
    ],
  },
  // The console dashboard: the latest pipelines of each GitLab project.
  dashboard: [
    {
      id: 'pipelines',
      title: 'Pipelines',
      tool: 'list_pipelines',
      args: { per_page: 20 },
      forEach: { setting: 'projects', from: 'gitlab', arg: 'id' },
      view: {
        kind: 'runs',
        items: 'items',
        fields: { id: 'id', ref: 'ref', status: ['status'], url: 'web_url', at: 'created_at' },
      },
    },
  ],
  // The GitLab connector's address and token.
  runtime: builtinRuntime('ci', 'gitlab'),
  variants: {
    setting: 'server',
    from: 'gitlab',
    options: {
      community: {
        // Only these pipeline tools are exposed. Never exposed: get_pipeline_variables and
        // get_pipeline_schedule_variable, which return CI/CD variable values (often secrets).
        tools: {
          ...Object.fromEntries(COMMUNITY_READS.map((name) => [name, 'read'])),
          ...Object.fromEntries(COMMUNITY_DESTRUCTIVE.map((name) => [name, 'destructive'])),
        },
        guards: Object.fromEntries(
          COMMUNITY_EXPOSED.map((name) => [name, [inGitlabProjects('project_id')]]),
        ),
        hiddenTools: [...GITLAB_CI_HIDDEN],
        dashboard: [
          {
            id: 'pipelines',
            title: 'Pipelines',
            tool: 'list_pipelines',
            args: { per_page: 20 },
            forEach: { setting: 'projects', from: 'gitlab', arg: 'project_id' },
            view: {
              kind: 'runs',
              fields: {
                id: 'id',
                ref: 'ref',
                status: ['status'],
                url: 'web_url',
                at: 'created_at',
              },
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
      },
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
