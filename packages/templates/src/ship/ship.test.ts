import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  chartName,
  checkDockerfile,
  detectStack,
  dockerfile,
  helmChart,
  mirrorImage,
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

  it('finds separate probes, the test command, and the port variable for Spring Boot', () => {
    const d = detect({
      'pom.xml': POM(
        '<dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency>',
      ),
      'src/main/resources/application.properties': 'server.port=${PORT:8080}\n',
      'src/test/java/AppTests.java': 'class AppTests {}',
    });
    expect(d).toMatchObject({
      probes: { liveness: '/actuator/health/liveness', readiness: '/actuator/health/readiness' },
      test: 'mvn -B test',
      portEnv: 'PORT',
    });
    const bare = detect({ 'pom.xml': POM() });
    expect(bare.probes).toBeUndefined();
    expect(bare.test).toBeNull();
    expect(bare.portEnv).toBeNull();
  });

  it('runs tests only when there are some, and pytest only when the requirements pin it', () => {
    const node = (test?: string) =>
      detect({
        'package.json': JSON.stringify({
          scripts: { start: 'node server.js', ...(test ? { test } : {}) },
        }),
        'package-lock.json': '{}',
        'server.js': 'app.listen(process.env.PORT || 3000)',
      });
    expect(node('vitest run').test).toBe('npm ci && npm test');
    expect(node('echo "Error: no test specified" && exit 1').test).toBeNull();
    expect(node().test).toBeNull();
    expect(node().portEnv).toBe('PORT');

    const python = (requirements: string) =>
      detect({
        'requirements.txt': requirements,
        'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
        'tests/test_main.py': 'def test_ok(): pass\n',
      });
    expect(python('fastapi==0.1\nuvicorn==0.2\npytest==8.4.2\n').test).toBe(
      'pip install --no-cache-dir -r requirements.txt && pytest',
    );
    expect(python('fastapi==0.1\nuvicorn==0.2\n').test).toBeNull();
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
      notes: expect.arrayContaining(['Go, main package at the repo root.']) as unknown,
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

  it('caches Maven and Gradle dependencies between builds', () => {
    expect(dockerfile(stacks[1] as Detection)).toContain('--mount=type=cache,target=/root/.m2');
    expect(dockerfile(stacks[2] as Detection)).toContain('--mount=type=cache,target=/root/.gradle');
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

  it('checks liveness without dependencies, and readiness with them', () => {
    const files = helmChart(
      {
        ...NODE,
        stack: 'spring-maven',
        java: { version: 21 },
        healthPath: '/actuator/health',
        probes: { liveness: '/actuator/health/liveness', readiness: '/actuator/health/readiness' },
      },
      { image: 'x', generatedDockerfile: true },
    );
    const values = parse(files['charts/api/values.yaml'] ?? '') as Record<
      string,
      { httpGet?: { path: string } }
    >;
    expect(values['startupProbe']?.httpGet?.path).toBe('/actuator/health/liveness');
    expect(values['livenessProbe']?.httpGet?.path).toBe('/actuator/health/liveness');
    expect(values['readinessProbe']?.httpGet?.path).toBe('/actuator/health/readiness');
  });

  it('sets the port variable from containerPort and leaves it out of the settings to fill in', () => {
    const files = helmChart(
      { ...NODE, portEnv: 'PORT' },
      {
        image: 'x',
        generatedDockerfile: true,
        env: { settings: ['PORT', 'LOG_LEVEL'], secrets: ['API_KEY'] },
      },
    );
    const values = files['charts/api/values.yaml'] ?? '';
    expect(values).toContain('#  - name: LOG_LEVEL');
    expect(values).not.toContain('name: PORT');
    expect(files['charts/api/templates/deployment.yaml']).toContain(
      '          env:\n            - name: PORT\n              value: {{ .Values.containerPort | quote }}',
    );
    const plain = helmChart(NODE, { image: 'x', generatedDockerfile: true });
    expect(plain['charts/api/templates/deployment.yaml']).not.toContain('name: PORT');
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

  it('tests before building, then pushes pr-<sha> from PRs and <sha> and appVersion from main', () => {
    const plan = planShip(
      { ...NODE, test: 'npm ci && npm test' },
      { provider: 'github', repo: 'acme/api', defaultBranch: 'main' },
    );
    const file = plan.files.find((f) => f.path.endsWith('container.yml'));
    const workflow = parse(file?.content ?? '') as {
      jobs: Record<
        string,
        { needs?: string; env?: Record<string, string>; steps: { run?: string; if?: string }[] }
      >;
    };
    expect(workflow.jobs['test']?.steps[1]?.run).toBe(
      'docker run --rm -v "$PWD:/src" -w /src node:24.21.0-alpine3.24 sh -c "npm ci && npm test"',
    );
    expect(workflow.jobs['image']?.needs).toBe('test');
    expect(workflow.jobs['image']?.env?.['SHA']).toBe(
      '${{ github.event.pull_request.head.sha || github.sha }}',
    );
    const push = workflow.jobs['image']?.steps[2];
    expect(push?.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(push?.run).toContain('tags="pr-$SHA"');
    expect(push?.run).toContain(`tags="$SHA $(grep '^appVersion:' charts/api/Chart.yaml`);
    expect(file?.reason).toContain('runs the tests (`npm ci && npm test`)');

    const none = planShip(NODE, { provider: 'github', repo: 'acme/api', defaultBranch: 'main' });
    const plain = parse(
      none.files.find((f) => f.path.endsWith('container.yml'))?.content ?? '',
    ) as { jobs: Record<string, { needs?: string }> };
    expect(plain.jobs['test']).toBeUndefined();
    expect(plain.jobs['image']?.needs).toBeUndefined();
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

  it('runs Go tests without cgo in GitLab CI, before the build', () => {
    const plan = planShip(
      { ...NODE, stack: 'go', go: { pkg: '.' }, test: 'go test ./...' },
      { provider: 'gitlab', repo: 'grp/api', defaultBranch: 'main' },
    );
    const ci = parse(plan.files.find((f) => f.path === '.gitlab-ci.yml')?.content ?? '') as Record<
      string,
      unknown
    >;
    expect(ci['stages']).toEqual(['test', 'build', 'package']);
    expect(ci['test']).toEqual({
      stage: 'test',
      image: 'golang:1.25.14-alpine3.24',
      variables: { CGO_ENABLED: '0' },
      script: ['go test ./...'],
    });
    const build = (ci['image-build'] as { script: string[] }).script.join('\n');
    expect(build).toContain('tags="pr-$CI_COMMIT_SHA"');
    expect(build).toContain('tags="$CI_COMMIT_SHA $(grep');
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

describe('base image mirrors', () => {
  const mirrors = {
    'docker.io': 'harbor.example.com/dockerhub-proxy',
    'gcr.io': 'harbor.example.com/gcr-proxy/',
  };

  it('pulls each registry through its mirror, keeping tags and digests', () => {
    expect(mirrorImage('node:24.21.0-alpine3.24', mirrors)).toBe(
      'harbor.example.com/dockerhub-proxy/library/node:24.21.0-alpine3.24',
    );
    expect(mirrorImage('alpine/helm:4.3.0', mirrors)).toBe(
      'harbor.example.com/dockerhub-proxy/alpine/helm:4.3.0',
    );
    expect(mirrorImage('gcr.io/distroless/static-debian12:nonroot@sha256:abc', mirrors)).toBe(
      'harbor.example.com/gcr-proxy/distroless/static-debian12:nonroot@sha256:abc',
    );
    expect(mirrorImage('quay.io/org/app:1', mirrors)).toBe('quay.io/org/app:1');
  });

  it('rewrites the generated Dockerfile and CI, and nothing else', () => {
    const plain = planShip(NODE, { provider: 'github', repo: 'acme/api', defaultBranch: 'main' });
    const mirrored = planShip(NODE, {
      provider: 'github',
      repo: 'acme/api',
      defaultBranch: 'main',
      mirrors,
    });
    const dockerfile = mirrored.files.find((f) => f.path === 'Dockerfile')?.content ?? '';
    expect(dockerfile).toContain(
      'FROM harbor.example.com/dockerhub-proxy/library/node:24.21.0-alpine3.24',
    );
    expect(dockerfile).not.toMatch(/FROM node:/);
    expect(mirrored.files.map((f) => f.path)).toEqual(plain.files.map((f) => f.path));
    expect(
      planShip(NODE, { provider: 'github', repo: 'acme/api', defaultBranch: 'main', mirrors: {} })
        .files,
    ).toEqual(plain.files);
  });
});
