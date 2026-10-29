import { detectStack, type DetectResult, type RepoFiles } from '../ship/detect.ts';
import { findConfigVars, type ConfigVar } from './config-vars.ts';
import { findDependencies, MANIFEST_FILE, type Dependency } from './dependencies.ts';
import {
  committedEnvFiles,
  scanSecrets,
  type SecretHit,
  type SecretPattern,
} from './secret-scan.ts';

export interface Finding {
  /** risk: fix before shipping; gap: worth fixing soon. */
  level: 'risk' | 'gap';
  text: string;
}

export interface Analysis {
  detection: DetectResult;
  /** Folders below the root with their own build file (a monorepo when there are several). */
  services: string[];
  dependencies: Dependency[];
  config: ConfigVar[];
  secrets: SecretHit[];
  /** Migration tools and their folders, e.g. "Flyway (src/main/resources/db/migration)". */
  migrations: string[];
  /** How to run the tests, or null when none were found. */
  tests: string | null;
  findings: Finding[];
  /** What a DevOps engineer would ask the team before running this in production. */
  questions: string[];
}

const has = (files: RepoFiles, path: string) => files.paths.includes(path);
const any = (files: RepoFiles, test: RegExp) => files.paths.some((p) => test.test(p));

function findServices(files: RepoFiles): string[] {
  const dirs = new Set<string>();
  for (const path of files.paths) {
    const parts = path.split('/');
    if (parts.length < 2 || parts.length > 3 || !MANIFEST_FILE.test(path)) continue;
    if (/^(examples?|docs?|test|tests|scripts)\//.test(path)) continue;
    dirs.add(parts.slice(0, -1).join('/'));
  }
  return [...dirs].sort();
}

const MIGRATIONS: readonly [string, RegExp][] = [
  ['Flyway', /^(.*\/)?src\/main\/resources\/db\/migration\/V[^/]+\.sql$/],
  ['Liquibase', /^(.*\/)?(db\/changelog|liquibase)\/[^/]+\.(xml|ya?ml|sql)$/],
  ['Alembic', /^(.*\/)?alembic(\.ini|\/env\.py)$/],
  ['Prisma', /^(.*\/)?prisma\/migrations\/[^/]+\/migration\.sql$/],
  ['Django', /^(.*\/)?migrations\/\d{4}_[^/]+\.py$/],
  ['SQL migrations', /^(.*\/)?migrations?\/[^/]+\.(up\.)?sql$/],
];

function findMigrations(files: RepoFiles): string[] {
  const out: string[] = [];
  for (const [tool, pattern] of MIGRATIONS) {
    const path = files.paths.find((p) => pattern.test(p));
    if (!path || out.some((o) => o.startsWith(tool))) continue;
    if (tool === 'SQL migrations' && out.length > 0) continue;
    out.push(`${tool} (${path.split('/').slice(0, -1).join('/') || '.'})`);
  }
  return out;
}

function findTests(files: RepoFiles, detection: DetectResult): string | null {
  const stack = detection.ok ? detection.detection.stack : null;
  if (stack === 'spring-maven' || has(files, 'pom.xml')) {
    return any(files, /^src\/test\//) ? (has(files, 'mvnw') ? './mvnw test' : 'mvn test') : null;
  }
  if (stack === 'spring-gradle' || has(files, 'build.gradle') || has(files, 'build.gradle.kts')) {
    return any(files, /^src\/test\//)
      ? has(files, 'gradlew')
        ? './gradlew test'
        : 'gradle test'
      : null;
  }
  if (has(files, 'package.json')) {
    try {
      const pkg = JSON.parse(files.read('package.json') ?? '') as {
        scripts?: Record<string, unknown>;
      };
      const test = pkg.scripts?.['test'];
      return typeof test === 'string' && !test.includes('no test specified') ? 'npm test' : null;
    } catch {
      return null;
    }
  }
  if (has(files, 'go.mod')) return any(files, /_test\.go$/) ? 'go test ./...' : null;
  if (has(files, 'requirements.txt') || has(files, 'pyproject.toml')) {
    return any(files, /(^|\/)(test_[^/]+|[^/]+_test)\.py$/) ? 'pytest' : null;
  }
  return null;
}

/** Problems in files the repo already has: a root or unpinned Dockerfile, CI without tests. */
function existingGaps(files: RepoFiles): Finding[] {
  const gaps: Finding[] = [];
  const dockerfile = files.read('Dockerfile');
  if (dockerfile !== undefined) {
    const users = [...dockerfile.matchAll(/^\s*USER\s+(\S+)/gim)].map((m) => m[1] ?? '');
    const last = users.at(-1);
    if (last === undefined || last === 'root' || last === '0') {
      gaps.push({
        level: 'gap',
        text: 'The Dockerfile runs the app as root. Add a non-root `USER`.',
      });
    }
    const unpinned = [...dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)]
      .map((m) => m[1] ?? '')
      .filter((image) => image !== 'scratch' && !image.includes('$'))
      .filter(
        (image) => !image.includes('@') && (!/:[^/]+$/.test(image) || image.endsWith(':latest')),
      );
    if (unpinned.length > 0) {
      gaps.push({
        level: 'gap',
        text: `The Dockerfile uses unpinned base images (${unpinned.join(', ')}). Pin a version or digest.`,
      });
    }
  }
  const ci = files.paths.filter((p) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^Jenkinsfile$/.test(p),
  );
  if (
    ci.length > 0 &&
    !ci.some((p) => /\btest\b|pytest|go test|mvn\w* (\S+ )*verify/i.test(files.read(p) ?? ''))
  ) {
    gaps.push({ level: 'gap', text: `CI (${ci.join(', ')}) never runs the tests.` });
  }
  return gaps;
}

function lockfileGaps(files: RepoFiles): Finding[] {
  if (
    has(files, 'package.json') &&
    !any(files, /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/)
  ) {
    return [
      {
        level: 'gap',
        text: 'No lockfile for package.json, so builds can pull different versions each time.',
      },
    ];
  }
  if (
    has(files, 'go.mod') &&
    !has(files, 'go.sum') &&
    /^require/m.test(files.read('go.mod') ?? '')
  ) {
    return [{ level: 'gap', text: 'go.sum is missing, so dependencies are not checked.' }];
  }
  const requirements = files.read('requirements.txt');
  if (requirements !== undefined) {
    const loose = requirements
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l && !l.startsWith('-') && !l.includes('=='));
    if (loose.length > 0) {
      return [
        {
          level: 'gap',
          text: `requirements.txt has unpinned packages (${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', ...' : ''}). Pin them with ==.`,
        },
      ];
    }
  }
  return [];
}

const list = (names: string[]) =>
  names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`;

function questionsFor(a: Omit<Analysis, 'questions'>): string[] {
  const q: string[] = [];
  if (!a.detection.ok) q.push('How is this app built and started today?');
  if (a.services.length > 1) {
    q.push(`Which of ${list(a.services)} are deployed, and as separate services?`);
  }
  for (const d of a.dependencies) {
    q.push(
      d.kind === 'database'
        ? `The code uses ${d.name}. Which instance does each environment use, and who owns its backups?`
        : `The code uses ${d.name}. Which instance does each environment use?`,
    );
  }
  const secrets = a.config.filter((v) => v.secret).map((v) => v.name);
  if (secrets.length > 0) {
    q.push(
      secrets.length === 1
        ? `Where does ${list(secrets)} live today, and who can rotate it?`
        : `Where do ${list(secrets)} live today, and who can rotate them?`,
    );
  }
  const settings = a.config.filter((v) => !v.secret).map((v) => v.name);
  if (settings.length > 0) q.push(`What values do ${list(settings)} take in each environment?`);
  for (const hit of a.secrets) {
    q.push(
      `A credential (${hit.rule}) is committed at ${hit.path}:${String(hit.line)}. Has it been rotated?`,
    );
  }
  if (a.detection.ok && a.detection.detection.healthPath === null) {
    q.push(
      'Can the app serve a health endpoint (for example /healthz) so Kubernetes knows when it is ready?',
    );
  }
  if (a.migrations.length > 0) {
    q.push(
      'Do the database migrations run when the app starts, or as a separate step before a deploy?',
    );
  }
  if (a.tests === null)
    q.push('There are no tests. Is that expected, or do they live somewhere else?');
  q.push('Who owns this service, and who should be paged when it breaks?');
  return q;
}

/**
 * What a DevOps engineer works out before touching a new repo: the stack, what the app
 * depends on, the settings it reads, committed credentials, migrations, tests, and the
 * questions for the team. File contents only: nothing is run, and no secret value is kept.
 */
export function analyzeRepo(
  files: RepoFiles,
  repoName: string,
  secretPatterns: readonly SecretPattern[],
): Analysis {
  const detection = detectStack(files, repoName);
  const services = findServices(files);
  const secrets = scanSecrets(files, secretPatterns);
  const tests = findTests(files, detection);
  const findings: Finding[] = [
    ...committedEnvFiles(files).map((p): Finding => ({
      level: 'risk',
      text: `${p} is committed. It usually holds real settings: remove it and rotate what it held.`,
    })),
    ...(secrets.length > 0
      ? [
          {
            level: 'risk' as const,
            text: `${String(secrets.length)} committed credential${secrets.length === 1 ? '' : 's'} found. Rotate ${secrets.length === 1 ? 'it' : 'them'}: removing the file does not remove git history.`,
          },
        ]
      : []),
    ...(detection.ok
      ? []
      : [{ level: 'gap' as const, text: `Not shipped automatically: ${detection.reason}` }]),
    ...existingGaps(files),
    ...lockfileGaps(files),
    ...(tests === null ? [{ level: 'gap' as const, text: 'No tests found.' }] : []),
    ...(detection.ok && detection.detection.healthPath === null
      ? [
          {
            level: 'gap' as const,
            text: 'No HTTP health endpoint: Kubernetes can only check that the port is open.',
          },
        ]
      : []),
  ];
  const partial = {
    detection,
    services,
    dependencies: findDependencies(files),
    config: findConfigVars(files),
    secrets,
    migrations: findMigrations(files),
    tests,
    findings,
  };
  return { ...partial, questions: questionsFor(partial) };
}
