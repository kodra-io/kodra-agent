import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { helmChart } from '../ship/chart.ts';
import { detectStack, type RepoFiles } from '../ship/detect.ts';
import { planShip, shipPrBody } from '../ship/plan.ts';
import {
  analyzeRepo,
  findConfigVars,
  findDependencies,
  isSecretName,
  onboardingReport,
  scanSecrets,
  type SecretPattern,
} from './index.ts';

const repo = (files: Record<string, string>): RepoFiles => ({
  paths: Object.keys(files).sort(),
  read: (p) => files[p],
});

// The shapes the agent passes in (a subset of its redactor's TOKEN_PATTERNS).
const PATTERNS: SecretPattern[] = [
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    name: 'kubeconfig-credential',
    pattern:
      /(\b(?:client-key-data|client-certificate-data|token|password)\s*:\s*)["']?[^\s"']{8,}["']?/g,
  },
];

const LEAKED = 'ghp_onboardCanary0123456789abcdefABCD'; // gitleaks:allow

const NODE_APP = {
  'package.json': JSON.stringify({
    scripts: { start: 'node server.js', test: 'vitest run' },
    dependencies: { pg: '8.13.1', ioredis: '5.4.2', express: '4.21.2' },
  }),
  'package-lock.json': '{}',
  'server.js': [
    'const port = process.env.PORT || 3000;',
    'const db = process.env.DATABASE_URL;',
    "const key = process.env['STRIPE_API_KEY'];",
    'const level = process.env.LOG_LEVEL;',
    `const token = '${LEAKED}';`,
    "app.get('/healthz', ok);",
    'app.listen(port);',
  ].join('\n'),
  'server.test.js': 'process.env.TEST_ONLY_VAR;',
  '.env.example': 'SESSION_SECRET=\nFEATURE_FLAGS=a,b\n',
  'docker-compose.yml':
    'services:\n  db:\n    image: postgres:16.4\n  mq:\n    image: docker.io/library/rabbitmq:3.13-management\n',
  'migrations/001_init.sql': 'CREATE TABLE IF NOT EXISTS t (id int);',
};

describe('findDependencies', () => {
  it('reads library names and Compose images', () => {
    const deps = findDependencies(repo(NODE_APP));
    expect(deps.map((d) => d.name)).toEqual(['PostgreSQL', 'Redis', 'RabbitMQ']);
    expect(deps[0]?.evidence).toEqual(['docker-compose.yml', 'package.json']);
  });

  it('finds Spring, Python, and Go drivers', () => {
    const names = (files: Record<string, string>) =>
      findDependencies(repo(files)).map((d) => d.name);
    expect(
      names({
        'pom.xml':
          '<artifactId>mariadb-java-client</artifactId><artifactId>spring-boot-starter-amqp</artifactId>',
      }),
    ).toEqual(['MySQL or MariaDB', 'RabbitMQ']);
    expect(names({ 'requirements.txt': 'psycopg[binary]==3.2.3\nboto3==1.35.0\n' })).toEqual([
      'PostgreSQL',
      'AWS (S3 or other AWS services)',
    ]);
    expect(names({ 'go.mod': 'require github.com/jackc/pgx/v5 v5.7.1' })).toEqual(['PostgreSQL']);
  });

  it('ignores vendored dependencies', () => {
    expect(findDependencies(repo({ 'node_modules/x/package.json': '"pg"' }))).toEqual([]);
  });
});

describe('findConfigVars', () => {
  it('finds variables in each language, flags secrets, and skips tests', () => {
    const vars = findConfigVars(
      repo({
        ...NODE_APP,
        'app/main.py': "x = os.getenv('PY_SETTING')\ny = os.environ['PY_PASSWORD']",
        'Main.java': 'System.getenv("JAVA_TOKEN")',
        'main.go': 'os.Getenv("GO_ADDR")',
        'src/main/resources/application.yml': 'url: ${DB_URL:jdbc:x}\nuser: ${DB_USER}',
      }),
    );
    const byName = Object.fromEntries(vars.map((v) => [v.name, v.secret]));
    expect(byName).toEqual({
      DATABASE_URL: true,
      DB_URL: true,
      DB_USER: false,
      FEATURE_FLAGS: false,
      GO_ADDR: false,
      JAVA_TOKEN: true,
      LOG_LEVEL: false,
      PORT: false,
      PY_PASSWORD: true,
      PY_SETTING: false,
      SESSION_SECRET: true,
      STRIPE_API_KEY: true,
    });
    expect(vars.find((v) => v.name === 'PORT')?.files).toEqual(['server.js']);
  });

  it('classifies secret names', () => {
    for (const name of [
      'JWT_SECRET',
      'DB_PASSWORD',
      'API_KEY',
      'SIGNING_KEY',
      'SENTRY_DSN',
      'REDIS_URL',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['PORT', 'LOG_LEVEL', 'KEYCLOAK_REALM', 'PUBLIC_URL', 'NODE_ENV']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});

describe('scanSecrets', () => {
  it('reports the file, line, and rule, never the value', () => {
    const hits = scanSecrets(repo(NODE_APP), PATTERNS);
    expect(hits).toEqual([{ path: 'server.js', line: 5, rule: 'github-token' }]);
    expect(JSON.stringify(hits)).not.toContain(LEAKED);
  });

  it('skips placeholders, examples, lockfiles, and binaries', () => {
    expect(
      scanSecrets(
        repo({
          'application.yml': 'password: ${DB_PASSWORD}\ntoken: {{ .Values.token }}',
          'README.md': 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
          'package-lock.json': LEAKED,
          'logo.png': LEAKED,
        }),
        PATTERNS,
      ),
    ).toEqual([]);
    expect(scanSecrets(repo({ 'config.yml': 'password: hunter2hunter2' }), PATTERNS)).toEqual([
      { path: 'config.yml', line: 1, rule: 'kubeconfig-credential' },
    ]);
  });
});

describe('analyzeRepo', () => {
  it('collects what a DevOps engineer needs before shipping', () => {
    const a = analyzeRepo(repo(NODE_APP), 'acme/api', PATTERNS);
    expect(a.detection.ok).toBe(true);
    expect(a.tests).toBe('npm test');
    expect(a.migrations).toEqual(['SQL migrations (migrations)']);
    expect(a.findings.filter((f) => f.level === 'risk').map((f) => f.text)).toEqual([
      '1 committed credential found. Rotate it: removing the file does not remove git history.',
    ]);
    expect(a.questions).toContain(
      'The code uses PostgreSQL. Which instance does each environment use, and who owns its backups?',
    );
    expect(a.questions).toContain(
      'Where do DATABASE_URL, SESSION_SECRET, and STRIPE_API_KEY live today, and who can rotate them?',
    );
    expect(a.questions).toContain(
      'A credential (github-token) is committed at server.js:5. Has it been rotated?',
    );
    expect(a.questions.at(-1)).toBe(
      'Who owns this service, and who should be paged when it breaks?',
    );
  });

  it('reports an unsupported repo instead of stopping, with its services', () => {
    const a = analyzeRepo(
      repo({
        'api/package.json': '{"dependencies":{"mysql2":"3.11.0"}}',
        'worker/requirements.txt': 'redis\ncelery==5.4.0',
        'README.md': '# Monorepo',
      }),
      'acme/mono',
      PATTERNS,
    );
    expect(a.detection.ok).toBe(false);
    expect(a.services).toEqual(['api', 'worker']);
    expect(a.questions[0]).toBe('How is this app built and started today?');
    expect(a.questions[1]).toBe('Which of api and worker are deployed, and as separate services?');
    expect(a.tests).toBeNull();
  });

  it('flags a committed .env, a root Dockerfile, unpinned images, CI without tests, and loose pins', () => {
    const a = analyzeRepo(
      repo({
        'requirements.txt': 'flask\ngunicorn==23.0.0\n',
        'app.py': 'app = Flask(__name__)',
        '.env': 'whatever',
        Dockerfile: 'FROM python:latest\nCOPY . .\nCMD ["python", "app.py"]',
        '.github/workflows/build.yml': 'jobs:\n  build:\n    steps:\n      - run: docker build .',
      }),
      'acme/py',
      PATTERNS,
    );
    const texts = a.findings.map((f) => `${f.level}: ${f.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^risk: \.env is committed/),
        'gap: The Dockerfile runs the app as root. Add a non-root `USER`.',
        'gap: The Dockerfile uses unpinned base images (python:latest). Pin a version or digest.',
        'gap: CI (.github/workflows/build.yml) never runs the tests.',
        'gap: requirements.txt has unpinned packages (flask). Pin them with ==.',
        'gap: No tests found.',
      ]),
    );
  });
});

describe('onboardingReport', () => {
  it('renders every section without a secret value', () => {
    const report = onboardingReport('acme/api', analyzeRepo(repo(NODE_APP), 'acme/api', PATTERNS));
    for (const heading of [
      '# Onboarding: acme/api',
      '## The app',
      '## What it depends on',
      '## Settings it reads',
      '## Database migrations',
      '## Tests',
      '## Committed credentials',
      '## Risks',
      '## Questions for the team',
      '## Next steps the agent does not do yet',
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain('| `STRIPE_API_KEY` | secret | `server.js` |');
    expect(report).toContain('- `server.js:5` (github-token)');
    expect(report).not.toContain(LEAKED);
  });
});

describe('the chart and PR with onboarding', () => {
  const detection = () => {
    const r = detectStack(repo(NODE_APP), 'acme/api');
    if (!r.ok) throw new Error(r.reason);
    return r.detection;
  };

  it('lists setting names to fill in and loads secrets from a Secret, with no values', () => {
    const chart = helmChart(detection(), {
      image: 'ghcr.io/acme/api',
      generatedDockerfile: true,
      env: { settings: ['LOG_LEVEL', 'PORT'], secrets: ['DATABASE_URL', 'STRIPE_API_KEY'] },
    });
    const values = chart['charts/api/values.yaml'] ?? '';
    expect(parse(values)).toMatchObject({ env: [], envFromSecret: '' });
    expect(values).toContain('#  - name: LOG_LEVEL');
    expect(values).toContain('# The code reads: DATABASE_URL, STRIPE_API_KEY.');
    expect(values).toContain(
      'kubectl create secret generic api-env --from-literal=DATABASE_URL=... --from-literal=STRIPE_API_KEY=...',
    );
    expect(chart['charts/api/templates/deployment.yaml']).toContain(
      '{{- with .Values.envFromSecret }}\n          envFrom:\n            - secretRef:\n                name: {{ . }}',
    );
  });

  it('adds the onboarding section and the Secret step to the PR description', () => {
    const d = detection();
    const plan = planShip(d, { provider: 'github', repo: 'acme/api', defaultBranch: 'main' });
    const body = shipPrBody({
      detection: d,
      plan,
      verification: [],
      modelChanges: [],
      onboarding: {
        reportPath: 'ONBOARDING.md',
        questions: ['Who owns it?'],
        secrets: ['DB_PASSWORD'],
      },
    });
    expect(body).toContain('## Onboarding\n`ONBOARDING.md` describes');
    expect(body).toContain('1. Who owns it?');
    expect(body).toContain(
      '- Create a Secret holding `DB_PASSWORD` and set `envFromSecret` to its name.',
    );
    expect(shipPrBody({ detection: d, plan, verification: [], modelChanges: [] })).not.toContain(
      '## Onboarding',
    );
  });
});
