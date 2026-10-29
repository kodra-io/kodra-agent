export const PATTERNS = {
  githubRepo: '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$',
  gitlabProject: '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$',
  k8sNamespace: '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$',
  /** `namespace/name` of a workload, like `prod/mariadb`. */
  k8sWorkload: '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?/[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$',
  slackChannel: '^#[a-z0-9][a-z0-9_-]{0,79}$',
  awsRegion: '^[a-z]{2}(-gov)?-[a-z]+-\\d$',
  absolutePath: '^/.+$',
  pipelineMode: '^(auto|shared|standalone)$',
  /** A reusable workflow: `owner/repo/.github/workflows/build.yml@ref`. */
  githubWorkflowRef: '^[\\w.-]+/[\\w.-]+/\\.github/workflows/[\\w./-]+\\.ya?ml@[\\w./-]+$',
  /** Included files: `group/project:file.yml[,other.yml]@ref`. */
  gitlabTemplateRef: '^[\\w.-]+(/[\\w.-]+)+:[\\w./,-]+@[\\w./-]+$',
} as const;

/** How ship and onboard pick the pipeline (B1): the same two settings on GitHub and GitLab. */
export function pipelineFields(provider: 'github' | 'gitlab') {
  const github = provider === 'github';
  return [
    {
      kind: 'string' as const,
      key: 'pipeline',
      required: false,
      description: github
        ? 'The pipeline ship and onboard add: auto calls the reusable workflow most of the repos above already use, or adds a standalone one; shared or standalone forces one.'
        : 'The pipeline ship and onboard add: auto includes the template most of the projects above already use, or adds a standalone one; shared or standalone forces one.',
      pattern: PATTERNS.pipelineMode,
      patternHint: 'use auto, shared, or standalone',
      default: 'auto',
    },
    {
      kind: 'string' as const,
      key: 'pipelineTemplate',
      required: false,
      description: github
        ? 'The shared workflow to call, when the repos above do not show it yet. Pin it to a tag or commit.'
        : 'The shared template to include, when the projects above do not show it yet. Pin it to a tag or commit.',
      pattern: github ? PATTERNS.githubWorkflowRef : PATTERNS.gitlabTemplateRef,
      patternHint: github
        ? 'use owner/repo/.github/workflows/build.yml@v1'
        : 'use group/project:ci/build.yml@v1 (several files: a.yml,b.yml)',
      example: github
        ? 'acme/platform/.github/workflows/build.yml@v1'
        : 'acme/devops:ci/build.yml@v1',
    },
  ];
}

export const COMING_SOON_SUMMARY = { always: ['Coming soon.'] };
