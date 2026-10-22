export const PATTERNS = {
  githubRepo: '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$',
  gitlabProject: '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$',
  k8sNamespace: '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$',
  /** `namespace/name` of a workload, like `prod/mariadb`. */
  k8sWorkload: '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?/[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$',
  slackChannel: '^#[a-z0-9][a-z0-9_-]{0,79}$',
  awsRegion: '^[a-z]{2}(-gov)?-[a-z]+-\\d$',
  absolutePath: '^/.+$',
} as const;

export const COMING_SOON_SUMMARY = { always: ['Coming soon.'] };
