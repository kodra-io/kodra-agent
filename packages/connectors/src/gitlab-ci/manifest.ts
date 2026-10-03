import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { GITLAB_CI_HIDDEN, GITLAB_DENY_PATTERN, GITLAB_SERVER } from '../gitlab/server.ts';
import { t } from '../shared.ts';

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

const readSummary = t(
  'Reads pipelines, jobs, and job logs with the GitLab token.',
  'يقرأ خطوط الإنتاج والمهام وسجلاتها باستخدام رمز GitLab.',
);

export default defineManifest({
  id: 'gitlab-ci',
  displayName: 'GitLab CI',
  category: 'cicd',
  status: 'available',
  description: t(
    'Read pipelines and job logs. With write access, propose pipeline changes through merge requests.',
    'قراءة خطوط الإنتاج وسجلات المهام. مع صلاحية الكتابة، اقتراح تغييرات خط الإنتاج عبر طلبات الدمج.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [
    {
      anyOf: [{ connector: 'gitlab' }],
      message: t(
        'GitLab CI needs the GitLab connector, because it uses the same token.',
        'يحتاج GitLab CI إلى موصل GitLab لأنه يستخدم الرمز نفسه.',
      ),
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
    },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Proposes .gitlab-ci.yml changes through merge requests after you approve.',
        'يقترح تغييرات الملف .gitlab-ci.yml عبر طلبات الدمج بعد موافقتك.',
      ),
    ],
  },
});
