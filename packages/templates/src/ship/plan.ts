import { helmChart } from './chart.ts';
import { githubWorkflow, gitlabCi } from './ci.ts';
import type { Detection } from './detect.ts';
import { dockerfile, dockerignore } from './dockerfile.ts';

export type SourceProvider = 'github' | 'gitlab';

export interface PlanOptions {
  /** Where the repo lives; null for a local folder (no CI is generated). */
  provider: SourceProvider | null;
  /** owner/repo or group/project. */
  repo: string;
  defaultBranch: string;
  /** GitLab address, for the registry host. */
  gitlabUrl?: string;
}

export interface ShipFile {
  path: string;
  content: string;
  /** One line on why, for the PR description. */
  reason: string;
}

export interface ShipPlan {
  files: ShipFile[];
  /** What already existed and was left alone. */
  kept: string[];
  chartDir: string;
  image: string;
  generatedDockerfile: boolean;
}

/** Where CI pushes the image. Registries need lowercase names. */
export function imageRepository(o: PlanOptions, name: string): string {
  const repo = o.repo.toLowerCase();
  if (o.provider === 'github') return `ghcr.io/${repo}`;
  if (o.provider === 'gitlab') {
    const host = new URL(o.gitlabUrl ?? 'https://gitlab.com').host;
    return host === 'gitlab.com' ? `registry.gitlab.com/${repo}` : `registry.${host}/${repo}`;
  }
  return name;
}

/** What to add to the repo: only what is missing, from tested templates. */
export function planShip(d: Detection, o: PlanOptions): ShipPlan {
  const files: ShipFile[] = [];
  const kept: string[] = [];
  const image = imageRepository(o, d.name);

  if (d.existing.dockerfile) {
    kept.push('Dockerfile: the existing one is used as is.');
  } else {
    files.push({
      path: 'Dockerfile',
      content: dockerfile(d),
      reason: 'Multi-stage build on pinned base images; the final image runs as a non-root user.',
    });
  }
  if (!d.existing.dockerignore) {
    files.push({
      path: '.dockerignore',
      content: dockerignore(),
      reason: 'Keeps .git, dependencies, build output, and .env files out of the image.',
    });
  }

  let chartDir = `charts/${d.name}`;
  if (d.existing.chart !== null) {
    chartDir = d.existing.chart;
    kept.push(`Helm chart: the existing one in ${chartDir} is linted, not replaced.`);
  } else {
    for (const [path, content] of Object.entries(
      helmChart(d, { image, generatedDockerfile: !d.existing.dockerfile }),
    )) {
      files.push({
        path,
        content,
        reason:
          'Helm chart: deployment and service, startup, liveness, and readiness probes, resource requests, non-root with a read-only root filesystem.',
      });
    }
  }

  const ci = { image, chartDir, defaultBranch: o.defaultBranch };
  if (o.provider === 'github') {
    if (d.existing.githubCi) kept.push('CI: a workflow already builds a container.');
    else
      files.push({
        path: '.github/workflows/container.yml',
        content: githubWorkflow(ci),
        reason: `GitHub Actions: builds the image on every PR, pushes it to ${image} from ${o.defaultBranch}, and lints the chart.`,
      });
  } else if (o.provider === 'gitlab') {
    if (d.existing.gitlabCi) kept.push('CI: .gitlab-ci.yml exists, so it is left alone.');
    else
      files.push({
        path: '.gitlab-ci.yml',
        content: gitlabCi(ci),
        reason: `GitLab CI: builds the image on every pipeline, pushes it to ${image} from the default branch, and lints the chart.`,
      });
  }
  return { files, kept, chartDir, image, generatedDockerfile: !d.existing.dockerfile };
}

export interface PrBodyInput {
  detection: Detection;
  plan: ShipPlan;
  /** What was checked and how it went. */
  verification: string[];
  /** Changes the model made to fix a failed build, if any. */
  modelChanges: string[];
}

/** The PR description: what was detected, what each file is for, and how it was verified. */
export function shipPrBody(i: PrBodyInput): string {
  const byReason = new Map<string, string[]>();
  for (const f of i.plan.files) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.path]);
  return [
    'Kodra AI Agent prepared this pull request to build, containerize, and package this service.',
    'Nothing is deployed: review it, merge it, and your own CI takes it from there.',
    '',
    '## What was detected',
    ...i.detection.notes.map((n) => `- ${n}`),
    '',
    '## What this adds',
    ...[...byReason].map(
      ([reason, paths]) => `- ${paths.map((p) => `\`${p}\``).join(', ')}: ${reason}`,
    ),
    ...(i.plan.kept.length > 0 ? ['', '## Left as is', ...i.plan.kept.map((k) => `- ${k}`)] : []),
    '',
    '## How it was verified',
    ...i.verification.map((v) => `- ${v}`),
    ...(i.modelChanges.length > 0
      ? [
          '',
          '## Changed by the model',
          'The template did not build on the first try. The model changed the Dockerfile:',
          ...i.modelChanges.map((c) => `- ${c}`),
        ]
      : []),
    '',
    '## Before you deploy',
    `- The chart pulls \`${i.plan.image}\`. CI tags images with the commit SHA: deploy with \`--set image.tag=<sha>\`.`,
    '- Resource requests are a starting point. Tune them from real usage.',
    '',
  ].join('\n');
}
