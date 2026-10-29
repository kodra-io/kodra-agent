import { helmChart } from './chart.ts';
import { type CiTest, githubWorkflow, gitlabCi } from './ci.ts';
import type { Detection } from './detect.ts';
import { dockerfile, dockerignore } from './dockerfile.ts';
import { IMAGES, mirrorImage, pinnedImages } from './images.ts';
import { choosePipeline, type ChooseInput, type PipelineChoice } from './pipeline.ts';

/** Generated files with every pinned base image pulled through its mirror. */
function withMirrors(text: string, mirrors: Readonly<Record<string, string>>): string {
  if (Object.keys(mirrors).length === 0) return text;
  let out = text;
  for (const image of pinnedImages()) {
    out = out.split(image).join(`\u0000${mirrorImage(image, mirrors)}\u0000`);
  }
  return out.replaceAll('\u0000', '');
}

export type SourceProvider = 'github' | 'gitlab';

export interface PlanOptions {
  /** Where the repo lives; null for a local folder (no CI is generated). */
  provider: SourceProvider | null;
  /** owner/repo or group/project. */
  repo: string;
  defaultBranch: string;
  /** GitLab address, for the registry host. */
  gitlabUrl?: string;
  /** Registry mirrors for base images (spec.ship.baseImageMirrors). */
  mirrors?: Readonly<Record<string, string>>;
  /** Environment variables the code reads, for the chart (names only, from `onboard`). */
  env?: { settings: readonly string[]; secrets: readonly string[] };
  /** B1: what decides between a standalone pipeline and the team's shared one. */
  pipeline?: Pick<ChooseInput, 'mode' | 'template' | 'others' | 'spec' | 'secretPatterns'>;
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
  /** The pipeline style chosen, when CI was generated. */
  pipeline?: PipelineChoice;
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

/** The tests, in the same pinned image the Dockerfile builds with; null when there are none. */
function ciTest(d: Detection): CiTest | null {
  if (!d.test) return null;
  const java = d.java?.version ?? 21;
  switch (d.stack) {
    case 'spring-maven':
      return { image: IMAGES.maven[java], run: d.test };
    case 'spring-gradle':
      return { image: IMAGES.gradle[java], run: d.test };
    case 'node':
      return { image: IMAGES.node, run: d.test };
    case 'python':
      return { image: IMAGES.python, run: d.test };
    case 'go':
      // The Alpine image has no C compiler.
      return { image: IMAGES.golang, run: d.test, env: { CGO_ENABLED: '0' } };
  }
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
      helmChart(d, {
        image,
        generatedDockerfile: !d.existing.dockerfile,
        ...(o.env ? { env: o.env } : {}),
      }),
    )) {
      files.push({
        path,
        content,
        reason:
          'Helm chart: deployment and service, startup, liveness, and readiness probes, resource requests, non-root with a read-only root filesystem.',
      });
    }
  }

  const test = ciTest(d);
  const ci = { image, chartDir, defaultBranch: o.defaultBranch, test };
  const runs = test ? `runs the tests (\`${test.run}\`), ` : '';
  const hasCi =
    o.provider === 'github' ? d.existing.githubCi : o.provider === 'gitlab' && d.existing.gitlabCi;
  const pipeline =
    o.provider && !hasCi && o.pipeline
      ? choosePipeline({
          ...o.pipeline,
          provider: o.provider,
          repo: o.repo,
          defaultBranch: o.defaultBranch,
          detection: d,
          image,
          chartDir,
        })
      : undefined;
  if (pipeline?.mode === 'shared') {
    files.push({
      path: pipeline.path,
      content: pipeline.content,
      reason: `Calls the shared pipeline \`${pipeline.template}\`: ${pipeline.reason}`,
    });
  } else if (o.provider === 'github') {
    if (d.existing.githubCi) kept.push('CI: a workflow already builds a container.');
    else
      files.push({
        path: '.github/workflows/container.yml',
        content: githubWorkflow(ci),
        reason: `GitHub Actions: ${runs}builds the image on every PR, pushes it to ${image} (\`pr-<sha>\` from PRs, \`<sha>\` and the chart's appVersion from ${o.defaultBranch}), and lints the chart.`,
      });
  } else if (o.provider === 'gitlab') {
    if (d.existing.gitlabCi) kept.push('CI: .gitlab-ci.yml exists, so it is left alone.');
    else
      files.push({
        path: '.gitlab-ci.yml',
        content: gitlabCi(ci),
        reason: `GitLab CI: ${runs}builds the image on every pipeline, pushes it to ${image} (\`pr-<sha>\` from other branches, \`<sha>\` and the chart's appVersion from the default branch), and lints the chart.`,
      });
  }
  const mirrors = o.mirrors ?? {};
  return {
    files: files.map((f) => ({ ...f, content: withMirrors(f.content, mirrors) })),
    kept,
    chartDir,
    image,
    generatedDockerfile: !d.existing.dockerfile,
    ...(pipeline ? { pipeline } : {}),
  };
}

/** Why this pipeline style, and what to set before merging. */
function pipelineSection(p: PipelineChoice): string[] {
  if (p.mode === 'standalone') return ['## Pipeline', `A standalone pipeline. ${p.reason}`];
  return [
    '## Pipeline',
    `This repo calls the shared pipeline \`${p.template}\`. ${p.reason}`,
    'The agent did not run the shared pipeline: check that it passes on this pull request.',
    ...(p.todo.length > 0
      ? [
          '',
          'Set these before merging (marked in the file):',
          ...p.todo.map((t) => `- \`${t.name}\`: ${t.why}.`),
        ]
      : []),
  ];
}

export interface PrBodyInput {
  detection: Detection;
  plan: ShipPlan;
  /** What was checked and how it went. */
  verification: string[];
  /** Changes the model made to fix a failed build, if any. */
  modelChanges: string[];
  /** From `onboard`: the report's path in this PR, the questions, and the secrets to create. */
  onboarding?: { reportPath: string | null; questions: string[]; secrets: string[] };
}

/** The PR description: what was detected, what each file is for, and how it was verified. */
export function shipPrBody(i: PrBodyInput): string {
  const byReason = new Map<string, string[]>();
  for (const f of i.plan.files) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.path]);
  return [
    'Kodra AI Agent prepared this pull request to build, containerize, and package this service.',
    'Nothing is deployed: review it, merge it, and your own CI takes it from there.',
    '',
    ...(i.onboarding
      ? [
          '## Onboarding',
          ...(i.onboarding.reportPath
            ? [
                `\`${i.onboarding.reportPath}\` describes what the app depends on, the settings it reads, risks, and gaps.`,
                '',
              ]
            : []),
          'Questions for the team:',
          ...i.onboarding.questions.map((q, n) => `${String(n + 1)}. ${q}`),
          '',
        ]
      : []),
    '## What was detected',
    ...i.detection.notes.map((n) => `- ${n}`),
    '',
    '## What this adds',
    ...[...byReason].map(
      ([reason, paths]) => `- ${paths.map((p) => `\`${p}\``).join(', ')}: ${reason}`,
    ),
    ...(i.plan.kept.length > 0 ? ['', '## Left as is', ...i.plan.kept.map((k) => `- ${k}`)] : []),
    ...(i.plan.pipeline ? ['', ...pipelineSection(i.plan.pipeline)] : []),
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
    `- The chart pulls \`${i.plan.image}\`, tagged with the chart's appVersion by default. For repeatable rollouts, deploy the commit SHA tag: \`--set image.tag=<sha>\`.`,
    ...(i.onboarding && i.onboarding.secrets.length > 0
      ? [
          `- Create a Secret holding ${i.onboarding.secrets.map((s) => `\`${s}\``).join(', ')} and set \`envFromSecret\` to its name.`,
        ]
      : []),
    '- Resource requests are a starting point. Tune them from real usage.',
    '',
  ].join('\n');
}
