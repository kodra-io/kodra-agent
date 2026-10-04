import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  chartName,
  checkDockerfile,
  detectStack,
  dockerfile,
  helmChart,
  planShip,
  shipPrBody,
  type Detection,
  type RepoFiles,
} from './index.ts';

const repo = (files: Record<string, string>): RepoFiles => ({
  paths: Object.keys(files).sort(),
  read: (p) => files[p],
});

const detect = (files: Record<string, string>, name = 'acme/api') => {
  const result = detectStack(repo(files), name);
  if (!result.ok) throw new Error(result.reason);
  return result.detection;
};

const POM = (
  extra = '',
) => `<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent>
<properties><java.version>17</java.version></properties>
<dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency>${extra}</dependencies></project>`;

describe('detectStack', () => {
  it('detects Spring Boot with Maven: Java version, port, and Actuator', () => {
    const d = detect({
      'pom.xml': POM(
        '<dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency>',
      ),
      'src/main/resources/application.yml':
        'spring:\n  application:\n    name: x\nserver:\n  port: 9090\n',
    });
    expect(d).toMatchObject({
      stack: 'spring-maven',
      port: 9090,
      healthPath: '/actuator/health',
      java: { version: 17 },
    });
  });

  it('detects Spring Boot with Gradle and defaults to Java 21 and port 8080', () => {
    const d = detect({
      'build.gradle.kts': 'plugins { id("org.springframework.boot") version "4.1.1" }',
    });
    expect(d).toMatchObject({
      stack: 'spring-gradle',
      port: 8080,
      healthPath: null,
      java: { version: 21 },
    });
  });

  it('refuses a Java version without a pinned image, and Java that is not Spring Boot', () => {
    expect(detectStack(repo({ 'pom.xml': POM().replace('17', '11') }), 'a')).toEqual({
      ok: false,
      reason: 'Java 11 is not supported yet. Supported: 17, 21.',
    });
    expect(detectStack(repo({ 'pom.xml': '<project/>' }), 'a').ok).toBe(false);
  });

  it('detects Node.js: start command, build step, install mode, port, and health route', () => {
    const d = detect({
      'package.json': JSON.stringify({ scripts: { start: 'node dist/index.js', build: 'tsc' } }),
      'src/index.ts': "app.get('/healthz', ok);\napp.listen(process.env.PORT ?? 8085);",
    });
    expect(d).toMatchObject({
      stack: 'node',
      port: 8085,
      healthPath: '/healthz',
      node: { install: 'install', build: true, start: ['node', 'dist/index.js'] },
    });
  });

  it('refuses Node.js projects that use another package manager or have nothing to run', () => {
    expect(detectStack(repo({ 'package.json': '{}', 'pnpm-lock.yaml': '' }), 'a')).toEqual({
      ok: false,
      reason: 'Found pnpm-lock.yaml: only npm projects are supported for Node.js so far.',
    });
    expect(detectStack(repo({ 'package.json': '{}' }), 'a')).toMatchObject({ ok: false });
  });

  it('detects FastAPI and Flask apps by their app object', () => {
    const fast = detect({
      'requirements.txt': 'FastAPI==0.142.2\nuvicorn[standard]==0.54.0\n',
      'src/app/main.py': 'from fastapi import FastAPI\napi = FastAPI()\n',
    });
    expect(fast.python?.cmd).toEqual([
      'uvicorn',
      'src.app.main:api',
      '--host',
      '0.0.0.0',
      '--port',
      '8000',
    ]);
    const flask = detect({
      'requirements.txt': 'flask==3\ngunicorn==23\n',
      'app.py': 'app = Flask(__name__)\n@app.route("/health")\n',
    });
    expect(flask).toMatchObject({
      healthPath: '/health',
      python: { cmd: ['gunicorn', '--bind', '0.0.0.0:8000', 'app:app'] },
    });
  });

  it('asks for a production server instead of guessing one', () => {
    expect(
      detectStack(repo({ 'requirements.txt': 'fastapi\n', 'main.py': 'app = FastAPI()' }), 'a'),
    ).toEqual({ ok: false, reason: 'FastAPI needs a server: add uvicorn to requirements.txt.' });
  });

  it('detects Go at the root or in a single cmd/ package', () => {
    expect(
      detect({
        'go.mod': 'module x',
        'main.go': 'package main\nhttp.ListenAndServe(":9000", nil)',
      }),
    ).toMatchObject({
      stack: 'go',
      port: 9000,
      go: { pkg: '.' },
    });
    expect(
      detect({
        'go.mod': 'module x',
        'cmd/api/main.go': 'package main',
        'internal/x.go': 'package x',
      }).go,
    ).toEqual({ pkg: './cmd/api' });
    expect(
      detectStack(
        repo({ 'go.mod': 'm', 'cmd/a/main.go': 'package main', 'cmd/b/main.go': 'package main' }),
        'x',
      ),
    ).toEqual({
      ok: false,
      reason: 'Several main packages under cmd/ (./cmd/a, ./cmd/b): ship one service per repo.',
    });
  });

  it('notices what already exists', () => {
    const d = detect({
      'package.json': JSON.stringify({ main: 'index.js' }),
      Dockerfile: 'FROM node',
      'deploy/chart/Chart.yaml': 'name: x',
      '.github/workflows/ci.yml': 'steps:\n  - uses: docker/build-push-action@v6',
      '.gitlab-ci.yml': '',
    });
    expect(d.existing).toEqual({
      dockerfile: true,
      dockerignore: false,
      chart: 'deploy/chart',
      githubCi: true,
      gitlabCi: true,
    });
  });

  it('reports an unknown stack', () => {
    expect(detectStack(repo({ 'README.md': '' }), 'a').ok).toBe(false);
  });
});

describe('chartName', () => {
  it('makes a DNS-1123 name of at most 53 characters', () => {
    expect(chartName('acme/Payments_API.v2')).toBe('payments-api-v2');
    expect(chartName('acme/2fa')).toBe('app-2fa');
    expect(chartName(`acme/${'x'.repeat(80)}`)).toHaveLength(53);
  });
});

const NODE: Detection = {
  stack: 'node',
  name: 'api',
  port: 3000,
  healthPath: '/healthz',
  node: { install: 'ci', build: false, start: ['node', 'server.js'] },
  existing: {
    dockerfile: false,
    dockerignore: false,
    chart: null,
    githubCi: false,
    gitlabCi: false,
  },
  notes: ['Node.js with npm.'],
};

describe('dockerfile', () => {
  const stacks: Detection[] = [
    NODE,
    { ...NODE, stack: 'spring-maven', java: { version: 17 } },
    { ...NODE, stack: 'spring-gradle', java: { version: 21 } },
    { ...NODE, stack: 'python', python: { cmd: ['uvicorn', 'main:app'] } },
    { ...NODE, stack: 'go', go: { pkg: './cmd/api' } },
  ];

  it.each(stacks.map((d) => [d.stack, d] as const))('%s keeps every rule', (_name, d) => {
    const text = dockerfile(d);
    expect(checkDockerfile(text)).toEqual([]);
    expect(text).toContain('EXPOSE 3000');
    expect(text.match(/^FROM /gm)).toHaveLength(2);
  });
});

describe('checkDockerfile', () => {
  it('flags unpinned images and a root final stage, but allows stage references', () => {
    expect(
      checkDockerfile('FROM node AS build\nUSER 1000\nFROM build\nUSER root\n').map(
        (p) => p.problem,
      ),
    ).toEqual(['base image node is not pinned to a version', 'the final stage runs as root']);
    expect(checkDockerfile('FROM alpine:latest\n').map((p) => p.problem)).toEqual([
      'base image alpine:latest is not pinned to a version',
      'the final stage has no USER, so it runs as root',
    ]);
    // A USER in an earlier stage does not count for the final one.
    expect(checkDockerfile('FROM a:1 AS b\nUSER 10\nFROM c:2\n')).toHaveLength(1);
    expect(
      checkDockerfile('FROM r.io:5000/a/b:1.2@sha256:' + 'a'.repeat(64) + '\nUSER 10001\n'),
    ).toEqual([]);
  });
});

describe('helmChart', () => {
  it('runs as the image user with a read-only root filesystem and HTTP probes', () => {
    const files = helmChart(NODE, { image: 'ghcr.io/acme/api', generatedDockerfile: true });
    const values = parse(files['charts/api/values.yaml'] ?? '') as Record<
      string,
      Record<string, unknown>
    >;
    expect(values['podSecurityContext']).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(values['securityContext']).toMatchObject({
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    });
    expect(values['readinessProbe']).toMatchObject({ httpGet: { path: '/healthz', port: 'http' } });
    expect(values['image']).toMatchObject({ repository: 'ghcr.io/acme/api', tag: '' });
    expect(Object.keys(files).sort()).toEqual([
      'charts/api/.helmignore',
      'charts/api/Chart.yaml',
      'charts/api/templates/_helpers.tpl',
      'charts/api/templates/deployment.yaml',
      'charts/api/templates/service.yaml',
      'charts/api/values.yaml',
    ]);
  });

  it('uses TCP probes without a health path, and no runAsUser for an existing Dockerfile', () => {
    const files = helmChart(
      { ...NODE, healthPath: null },
      { image: 'x', generatedDockerfile: false },
    );
    const values = parse(files['charts/api/values.yaml'] ?? '') as Record<
      string,
      Record<string, unknown>
    >;
    expect(values['livenessProbe']).toMatchObject({ tcpSocket: { port: 'http' } });
    expect(values['podSecurityContext']).not.toHaveProperty('runAsUser');
  });
});

describe('planShip', () => {
  it('adds a Dockerfile, a chart, and GitHub Actions for a GitHub repo', () => {
    const plan = planShip(NODE, { provider: 'github', repo: 'Acme/API', defaultBranch: 'trunk' });
    expect(plan.image).toBe('ghcr.io/acme/api');
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'Dockerfile',
        '.dockerignore',
        'charts/api/Chart.yaml',
        '.github/workflows/container.yml',
      ]),
    );
    const workflow = parse(
      plan.files.find((f) => f.path.endsWith('container.yml'))?.content ?? '',
    ) as {
      on: { push: { branches: string[] } };
      jobs: Record<string, { steps: { run?: string; uses?: string }[] }>;
    };
    expect(workflow.on.push.branches).toEqual(['trunk']);
    expect(workflow.jobs['chart']?.steps.map((s) => s.run ?? s.uses)).toContain(
      'helm lint charts/api',
    );
    expect(workflow.jobs['image']?.steps[0]?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
  });

  it('adds GitLab CI and the project registry for a GitLab project', () => {
    const plan = planShip(NODE, {
      provider: 'gitlab',
      repo: 'grp/sub/api',
      defaultBranch: 'main',
      gitlabUrl: 'https://git.acme.dev',
    });
    expect(plan.image).toBe('registry.git.acme.dev/grp/sub/api');
    const ci = parse(plan.files.find((f) => f.path === '.gitlab-ci.yml')?.content ?? '') as Record<
      string,
      { script?: string[] }
    >;
    expect(ci['chart-lint']?.script).toContain('helm lint charts/api');
  });

  it('keeps what exists and lints an existing chart', () => {
    const plan = planShip(
      {
        ...NODE,
        existing: {
          dockerfile: true,
          dockerignore: true,
          chart: 'deploy/chart',
          githubCi: true,
          gitlabCi: false,
        },
      },
      { provider: 'github', repo: 'acme/api', defaultBranch: 'main' },
    );
    expect(plan.files).toEqual([]);
    expect(plan.chartDir).toBe('deploy/chart');
    expect(plan.kept).toHaveLength(3);
  });

  it('adds no CI for a local folder', () => {
    const plan = planShip(NODE, { provider: null, repo: 'api', defaultBranch: 'main' });
    expect(plan.files.some((f) => f.path.includes('workflows') || f.path.includes('gitlab'))).toBe(
      false,
    );
    expect(plan.image).toBe('api');
  });
});

describe('shipPrBody', () => {
  it('explains each file, the checks, and any model change', () => {
    const plan = planShip(NODE, { provider: 'github', repo: 'acme/api', defaultBranch: 'main' });
    const body = shipPrBody({
      detection: NODE,
      plan,
      verification: ['The image builds.'],
      modelChanges: ['Attempt 1: fixed the COPY.'],
    });
    expect(body).toContain('- Node.js with npm.');
    expect(body).toContain('`Dockerfile`: Multi-stage build');
    expect(body).toContain('- The image builds.');
    expect(body).toContain('## Changed by the model');
    expect(body).not.toMatch(/—/);
  });
});
