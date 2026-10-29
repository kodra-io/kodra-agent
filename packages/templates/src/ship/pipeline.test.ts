import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  choosePipeline,
  parseTemplateRef,
  planShip,
  readRepoCi,
  readTemplateSpec,
  sharedTemplate,
  shipPrBody,
  type ChooseInput,
  type Detection,
  type RepoCi,
} from './index.ts';

const SPRING: Detection = {
  stack: 'spring-maven',
  name: 'orders-service',
  port: 8080,
  healthPath: '/actuator/health',
  java: { version: 21 },
  test: 'mvn -B test',
  existing: {
    dockerfile: false,
    dockerignore: false,
    chart: null,
    githubCi: false,
    gitlabCi: false,
  },
  notes: ['Spring Boot with Maven.'],
};

// A literal token in another repo's CI must never be copied into this one.
const LEAKED = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = /ghp_[A-Za-z0-9]{36}/g;

const githubCaller = (service: string, ref: string, channel: string) => `
name: Build
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  build:
    uses: acme/platform/.github/workflows/build.yml@${ref}
    permissions:
      contents: read
      packages: write
    secrets: inherit
    with:
      image: ghcr.io/acme/${service}
      java-version: 17
      registry: ghcr.io
      sonar-project: acme_${service}
      slack-channel: "${channel}"
      deploy-token: ${LEAKED}
      legacy: "yes"
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo local }]
`;

const githubOthers = (): RepoCi[] => [
  readRepoCi('github', 'acme/payments', {
    '.github/workflows/build.yml': githubCaller('payments', 'v2', '#team-pay'),
  }),
  readRepoCi('github', 'acme/users', {
    '.github/workflows/build.yml': githubCaller('users', 'v2', '#team-id'),
  }),
  readRepoCi('github', 'acme/billing', {
    '.github/workflows/build.yml': githubCaller('billing', 'v1', '#team-pay'),
  }),
];

const GITHUB_TEMPLATE = `
on:
  workflow_call:
    inputs:
      image: { type: string, required: true }
      java-version: { type: number, required: true }
      registry: { type: string, required: false, default: ghcr.io }
      sonar-project: { type: string, required: true }
      slack-channel: { type: string, required: false }
      deploy-token: { type: string, required: false }
      environment: { type: string, required: true, description: "Where to deploy" }
    secrets:
      SONAR_TOKEN: { required: true }
jobs:
  build: { runs-on: ubuntu-latest, steps: [{ run: echo build }] }
`;

const input = (over: Partial<ChooseInput>): ChooseInput => ({
  provider: 'github',
  repo: 'acme/orders-service',
  defaultBranch: 'main',
  detection: SPRING,
  image: 'ghcr.io/acme/orders-service',
  chartDir: 'charts/orders-service',
  mode: 'auto',
  template: null,
  others: [],
  spec: null,
  secretPatterns: [TOKEN],
  ...over,
});

describe('parseTemplateRef', () => {
  it('reads GitHub reusable workflows and GitLab project includes', () => {
    expect(parseTemplateRef('github', 'acme/platform/.github/workflows/build.yml@v2')).toEqual({
      source: 'acme/platform',
      files: ['.github/workflows/build.yml'],
      ref: 'v2',
      values: {},
    });
    expect(parseTemplateRef('gitlab', 'kodra-io/devops:ci-build.yml,ci-deploy.yml@main')).toEqual({
      source: 'kodra-io/devops',
      files: ['ci-build.yml', 'ci-deploy.yml'],
      ref: 'main',
      values: {},
    });
    expect(parseTemplateRef('github', 'acme/platform/build.yml@v2')).toBeNull();
    expect(parseTemplateRef('gitlab', 'kodra-io/devops:ci.yml')).toBeNull();
  });
});

describe('sharedTemplate', () => {
  it('needs most of the repos with CI to agree, and takes their most common ref', () => {
    const agreed = sharedTemplate(githubOthers());
    expect(agreed?.use.ref).toBe('v2');
    expect(agreed?.users.map((u) => u.repo)).toEqual([
      'acme/payments',
      'acme/users',
      'acme/billing',
    ]);

    const own = readRepoCi('github', 'acme/a', { '.github/workflows/ci.yml': 'jobs: {}' });
    const lone = githubOthers().slice(0, 1);
    expect(sharedTemplate([...lone, own, { ...own, repo: 'acme/b' }])).toBeNull();
    // A repo without any CI does not count against it.
    expect(sharedTemplate([...lone, { repo: 'acme/c', file: null, uses: [] }])?.use.ref).toBe('v2');
  });
});

describe('choosePipeline on GitHub', () => {
  it('calls the shared workflow with the values it can work out, and lists the rest', () => {
    const choice = choosePipeline(
      input({ others: githubOthers(), spec: readTemplateSpec('github', GITHUB_TEMPLATE) }),
    );
    if (choice.mode !== 'shared') throw new Error(choice.reason);
    expect(choice.reason).toBe(
      '3 of the 3 other repos with CI call acme/platform/.github/workflows/build.yml@v2, so this repo calls it too.',
    );
    expect(choice.path).toBe('.github/workflows/build.yml');
    const wf = parse(choice.content) as {
      name: string;
      on: unknown;
      jobs: Record<string, Record<string, unknown>>;
    };
    expect(wf.name).toBe('Build');
    expect(wf.on).toEqual({ pull_request: null, push: { branches: ['main'] } });
    const job = wf.jobs['build'] ?? {};
    expect(job['uses']).toBe('acme/platform/.github/workflows/build.yml@v2');
    expect(job['secrets']).toBe('inherit');
    expect(job['permissions']).toEqual({ contents: 'read', packages: 'write' });
    expect(job['with']).toEqual({
      image: 'ghcr.io/acme/orders-service',
      // Detected, and typed as the template declares it.
      'java-version': 21,
      registry: 'ghcr.io',
      // Each repo's own name, adapted to this one.
      'sonar-project': 'acme_orders-service',
      'slack-channel': '',
      'deploy-token': '',
      environment: '',
    });
    // Only the shared call is copied, not the other repos' own jobs or undeclared inputs.
    expect(wf.jobs['lint']).toBeUndefined();
    expect(choice.content).not.toContain('legacy');
    expect(choice.content).not.toContain(LEAKED);
    expect(choice.todo).toEqual([
      {
        name: 'deploy-token',
        why: 'looks like a credential, so it was not copied from the other repos',
      },
      { name: 'environment', why: 'Where to deploy' },
      { name: 'slack-channel', why: 'differs between the other repos' },
    ]);
  });

  it('stays standalone when told to, or when there is nothing shared to learn from', () => {
    expect(choosePipeline(input({ mode: 'standalone', others: githubOthers() })).mode).toBe(
      'standalone',
    );
    expect(choosePipeline(input({}))).toEqual({
      mode: 'standalone',
      reason: 'No other repos are configured on this connector to learn a shared pipeline from.',
    });
  });

  it('uses a configured template even when no other repo calls it yet', () => {
    const choice = choosePipeline(
      input({
        template: parseTemplateRef('github', 'acme/platform/.github/workflows/build.yml@3f2a1b9'),
        spec: readTemplateSpec('github', GITHUB_TEMPLATE),
      }),
    );
    if (choice.mode !== 'shared') throw new Error(choice.reason);
    const job = (parse(choice.content) as { jobs: Record<string, Record<string, unknown>> }).jobs[
      'pipeline'
    ];
    expect(job?.['uses']).toBe('acme/platform/.github/workflows/build.yml@3f2a1b9');
    // The template requires a secret, so the caller passes the org's secrets on.
    expect(job?.['secrets']).toBe('inherit');
    expect(job?.['with']).toMatchObject({
      image: 'ghcr.io/acme/orders-service',
      'java-version': 21,
    });
    expect(choice.todo.map((t) => t.name)).toEqual(['environment', 'sonar-project']);
  });
});

describe('choosePipeline on GitLab', () => {
  const gitlabCaller = (service: string) => `
include:
  - project: kodra-io/devops
    ref: main
    file: /ci-build.yml
  - project: kodra-io/devops
    ref: main
    file: [/ci-deploy.yml]
stages: [build, deploy]
variables:
  SERVICE_NAME: ${service}
  HELM_CHART: charts/${service}
  REGISTRY: registry.gitlab.com/kodra-io
  DB_PASSWORD: hunter2-${service}
  STATIC_PASSWORD: same-everywhere
`;
  const others = () => [
    readRepoCi('gitlab', 'kodra-io/courses-service', {
      '.gitlab-ci.yml': gitlabCaller('courses-service'),
    }),
    readRepoCi('gitlab', 'kodra-io/admin-service', {
      '.gitlab-ci.yml': gitlabCaller('admin-service'),
    }),
  ];

  it('includes the shared files and sets the variables the other projects agree on', () => {
    const spec = readTemplateSpec(
      'gitlab',
      'build:\n  script:\n    - docker build -t "$REGISTRY/$SERVICE_NAME:$CI_COMMIT_SHA" .\n    - echo $NEW_SETTING\n',
    );
    expect(spec).toEqual({
      inputs: [],
      needs: ['NEW_SETTING', 'REGISTRY', 'SERVICE_NAME'],
      declared: false,
    });
    const choice = choosePipeline(
      input({ provider: 'gitlab', repo: 'kodra-io/orders-service', others: others(), spec }),
    );
    if (choice.mode !== 'shared') throw new Error(choice.reason);
    expect(choice.template).toBe('kodra-io/devops:/ci-build.yml,/ci-deploy.yml@main');
    const ci = parse(choice.content) as Record<string, unknown>;
    expect(ci['include']).toEqual([
      { project: 'kodra-io/devops', ref: 'main', file: '/ci-build.yml' },
      { project: 'kodra-io/devops', ref: 'main', file: '/ci-deploy.yml' },
    ]);
    expect(ci['stages']).toEqual(['build', 'deploy']);
    expect(ci['variables']).toEqual({
      DB_PASSWORD: '',
      HELM_CHART: 'charts/orders-service',
      NEW_SETTING: '',
      REGISTRY: 'registry.gitlab.com/kodra-io',
      SERVICE_NAME: 'orders-service',
      STATIC_PASSWORD: '',
    });
    expect(choice.content).not.toContain('hunter2');
    expect(choice.content).not.toContain('same-everywhere');
    expect(choice.todo.map((t) => t.name)).toEqual([
      'DB_PASSWORD',
      'NEW_SETTING',
      'STATIC_PASSWORD',
    ]);
  });

  it('reads declared spec:inputs and passes them on the include', () => {
    const spec = readTemplateSpec(
      'gitlab',
      'spec:\n  inputs:\n    service-name:\n    stage:\n      default: build\n    team:\n      description: Owning team\n---\nbuild:\n  script: [echo]\n',
    );
    expect(spec.declared).toBe(true);
    expect(spec.inputs).toEqual([
      { name: 'service-name', required: true },
      { name: 'stage', required: false },
      { name: 'team', required: true, description: 'Owning team' },
    ]);
    const choice = choosePipeline(
      input({
        provider: 'gitlab',
        repo: 'grp/orders-service',
        template: parseTemplateRef('gitlab', 'grp/ci:build.yml@v3'),
        spec,
      }),
    );
    if (choice.mode !== 'shared') throw new Error(choice.reason);
    expect((parse(choice.content) as { include: unknown[] }).include).toEqual([
      {
        project: 'grp/ci',
        ref: 'v3',
        file: 'build.yml',
        inputs: { 'service-name': 'orders-service', team: '' },
      },
    ]);
    expect(choice.todo).toEqual([{ name: 'team', why: 'Owning team' }]);
  });
});

describe('planShip with a shared pipeline', () => {
  it('writes the caller instead of a standalone workflow, and explains it in the PR', () => {
    const plan = planShip(SPRING, {
      provider: 'github',
      repo: 'acme/orders-service',
      defaultBranch: 'main',
      pipeline: {
        mode: 'auto',
        template: null,
        others: githubOthers(),
        spec: readTemplateSpec('github', GITHUB_TEMPLATE),
        secretPatterns: [TOKEN],
      },
    });
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain('.github/workflows/build.yml');
    expect(paths).not.toContain('.github/workflows/container.yml');
    expect(plan.pipeline?.mode).toBe('shared');
    const body = shipPrBody({ detection: SPRING, plan, verification: [], modelChanges: [] });
    expect(body).toContain(
      'This repo calls the shared pipeline `acme/platform/.github/workflows/build.yml@v2`.',
    );
    expect(body).toContain('- `environment`: Where to deploy.');
  });

  it('keeps an existing pipeline, shared or not', () => {
    const plan = planShip(
      { ...SPRING, existing: { ...SPRING.existing, githubCi: true } },
      {
        provider: 'github',
        repo: 'acme/orders-service',
        defaultBranch: 'main',
        pipeline: {
          mode: 'auto',
          template: null,
          others: githubOthers(),
          spec: null,
          secretPatterns: [],
        },
      },
    );
    expect(plan.pipeline).toBeUndefined();
    expect(plan.files.map((f) => f.path)).not.toContain('.github/workflows/build.yml');
  });
});
