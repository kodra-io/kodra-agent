import { defineManifest, type ToolGuard } from '@kodra-agent/schema';
import { t } from '../shared.ts';

/** Jobs by full name (`folder/job`): one listed, or under a listed folder. */
const inJobs: ToolGuard[] = [
  { kind: 'arg-in-setting', arg: 'fullname', setting: 'jobs', required: true, prefix: true },
];

/** Reads that name a job. */
const JOB_READS = [
  'get_item',
  'get_item_parameters',
  'get_build',
  'get_build_parameters',
  'get_build_console_output',
  'get_build_scripts',
  'get_build_test_report',
  'get_all_build_artifacts',
  'get_build_artifact',
  'get_build_artifact_url',
  'get_pending_inputs',
] as const;

/** Reads across the controller: jobs, views, the queue, nodes, and plugins. */
const GLOBAL_READS = [
  'get_all_items',
  'query_items',
  'get_all_views',
  'get_view',
  'get_running_builds',
  'get_all_queue_items',
  'get_queue_item',
  'get_all_nodes',
  'get_node',
  'get_all_plugins',
  'get_plugin',
  'get_plugin_dependency_graph',
  'get_plugins_with_backup',
  'get_plugins_with_problems',
  'get_plugins_with_updates',
] as const;

const readSummary = t(
  'Reads jobs, builds, console logs, and test reports with the Jenkins API token. Lists jobs, the queue, nodes, and plugins the token can see.',
  'يقرأ المهام والبناءات وسجلات وحدة التحكم وتقارير الاختبارات باستخدام رمز Jenkins. يعرض المهام والطابور والعقد والإضافات التي يراها الرمز.',
);

export default defineManifest({
  id: 'jenkins',
  displayName: 'Jenkins',
  category: 'cicd',
  status: 'available',
  description: t(
    'Read Jenkins jobs, builds, and console logs. With write access, stop a build after approval.',
    'قراءة مهام Jenkins وبناءاتها وسجلاتها. مع صلاحية الكتابة، إيقاف بناء بعد الموافقة.',
  ),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'url',
      required: true,
      description: t('Jenkins address.', 'عنوان Jenkins.'),
      example: 'https://jenkins.example.com',
    },
    {
      kind: 'string',
      key: 'username',
      required: true,
      description: t(
        'Jenkins user the API token belongs to.',
        'مستخدم Jenkins الذي يتبع له رمز الواجهة البرمجية.',
      ),
      pattern: '^[^\\s/]{1,100}$',
      patternHint: t('a Jenkins user id, without spaces', 'معرّف مستخدم Jenkins دون مسافات'),
    },
    {
      kind: 'string-list',
      key: 'jobs',
      required: true,
      description: t(
        'Jobs the agent may work with, by full name. A folder covers every job under it.',
        'المهام التي يعمل بها الوكيل، بالاسم الكامل. المجلد يشمل كل المهام داخله.',
      ),
      pattern: '^[^\\s/][^\\n]{0,199}$',
      patternHint: t(
        'a job or folder full name, like deploy-web or team-a/services',
        'اسم مهمة أو مجلد كامل، مثل deploy-web أو team-a/services',
      ),
      example: ['team-a/services', 'deploy-web'],
    },
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'JENKINS_API_TOKEN',
      defaultRef: 'env',
      required: true,
      description: t('Jenkins API token.', 'رمز الواجهة البرمجية في Jenkins.'),
      howToCreate: t(
        'Sign in to Jenkins as that user, open your profile, then Security, and add an API token. Give the user Read only on the jobs it should see (plus Cancel for write access).',
        'سجّل الدخول إلى Jenkins بذلك المستخدم، وافتح ملفك ثم Security، وأضف رمز API. امنح المستخدم صلاحية Read فقط على المهام التي يجب أن يراها (وCancel لصلاحية الكتابة).',
      ),
      minimumScopes: {
        'read-only': ['Overall/Read', 'Job/Read on the listed jobs'],
        'read-write-approved': ['Overall/Read', 'Job/Read and Job/Cancel on the listed jobs'],
      },
      probe: 'jenkins.who-am-i',
    },
  ],
  // mcp-jenkins 3.5.0 (lanbaoshen/mcp-jenkins), listed from the real server. Hidden: running
  // Groovy on the controller, reading or writing job and node config.xml (it can hold
  // credentials), and cancelling queue items (not tied to a job, so the job list cannot
  // scope it). See docs/connectors/jenkins.md.
  tools: {
    ...Object.fromEntries(JOB_READS.map((name) => [name, 'read'])),
    ...Object.fromEntries(GLOBAL_READS.map((name) => [name, 'read'])),
    stop_build: 'write',
    // Starting a build or answering a pipeline input can deploy.
    build_item: 'destructive',
    submit_input: 'destructive',
  },
  hiddenTools: [
    'run_groovy_script',
    'get_item_config',
    'set_item_config',
    'get_node_config',
    'set_node_config',
    'cancel_queue_item',
  ],
  guards: {
    ...Object.fromEntries(JOB_READS.map((name) => [name, inJobs])),
    stop_build: inJobs,
    build_item: inJobs,
    submit_input: inJobs,
  },
  // The console dashboard: the listed jobs and their last result.
  dashboard: [
    {
      id: 'jobs',
      title: t('Jobs', 'المهام'),
      tool: 'get_all_items',
      view: {
        kind: 'jobs',
        fields: { name: 'fullname', status: 'color', url: 'url' },
        // Jenkins job colors: blue passed, red failed, yellow unstable; _anime while building.
        states: {
          blue: 'passed',
          red: 'failed',
          yellow: 'failed',
          blue_anime: 'running',
          red_anime: 'running',
          yellow_anime: 'running',
          notbuilt_anime: 'running',
          aborted_anime: 'running',
        },
        scope: { field: 'fullname', setting: 'jobs' },
      },
    },
  ],
  runtime: {
    type: 'mcp-stdio',
    // Runs with uvx; the image installs it from docker/mcp/pypi/mcp-jenkins.txt.
    source: { kind: 'pypi', package: 'mcp-jenkins', version: '3.5.0', command: 'mcp-jenkins' },
    args: [],
    accessArgs: { 'read-only': ['--read-only'] },
    env: {
      JENKINS_URL: { setting: 'url' },
      JENKINS_USERNAME: { setting: 'username' },
      JENKINS_PASSWORD: { secret: 'token' },
      JENKINS_TIMEOUT: { value: '30' },
    },
  },
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      t(
        'Stops a running build of a listed job after approval. Starting builds and answering pipeline inputs are destructive: blocked unless destructiveActions is require-approval.',
        'يوقف بناءً قيد التشغيل لمهمة مدرجة بعد الموافقة. بدء البناءات والرد على مدخلات خط الإنتاج إجراءات خطرة: محظورة ما لم تكن destructiveActions مضبوطة على require-approval.',
      ),
    ],
  },
});
