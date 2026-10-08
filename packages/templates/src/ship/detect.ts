import { JAVA_VERSIONS, type JavaVersion } from './images.ts';

/** A read-only view of a repository: POSIX paths relative to its root. */
export interface RepoFiles {
  paths: readonly string[];
  /** File contents, or undefined if missing or too large to read. */
  read(path: string): string | undefined;
}

export type Stack = 'spring-maven' | 'spring-gradle' | 'node' | 'python' | 'go';

export interface Existing {
  dockerfile: boolean;
  dockerignore: boolean;
  /** Folder of an existing Helm chart, or null. */
  chart: string | null;
  /** A GitHub Actions workflow that already builds a container. */
  githubCi: boolean;
  gitlabCi: boolean;
}

export interface Detection {
  stack: Stack;
  /** DNS-1123 name used for the chart and image. */
  name: string;
  port: number;
  /** An HTTP health endpoint the app is known to serve, or null (probes use TCP). */
  healthPath: string | null;
  java?: { version: JavaVersion };
  node?: { install: 'ci' | 'install'; build: boolean; start: string[] };
  python?: { cmd: string[] };
  go?: { pkg: string };
  existing: Existing;
  /** Why each choice was made, for the PR description. */
  notes: string[];
}

export type DetectResult = { ok: true; detection: Detection } | { ok: false; reason: string };

/** A lowercase DNS-1123 label of at most 53 characters (Helm release name limit). */
export function chartName(repo: string): string {
  const last = repo.split('/').filter(Boolean).at(-1) ?? 'app';
  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 53)
    .replace(/-+$/, '');
  return /^[a-z]/.test(name) ? name : `app-${name}`.slice(0, 53);
}

const has = (files: RepoFiles, path: string) => files.paths.includes(path);

function existing(files: RepoFiles): Existing {
  const workflows = files.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const chartFile = files.paths.find((p) => p === 'Chart.yaml' || p.endsWith('/Chart.yaml'));
  return {
    dockerfile: has(files, 'Dockerfile'),
    dockerignore: has(files, '.dockerignore'),
    chart: chartFile === undefined ? null : chartFile.replace(/\/?Chart\.yaml$/, '') || '.',
    githubCi: workflows.some((p) =>
      /docker|build-push-action|buildah|kaniko/i.test(files.read(p) ?? ''),
    ),
    gitlabCi: has(files, '.gitlab-ci.yml'),
  };
}

/** The first number captured by any pattern in any of the files, if it is a valid port. */
function findPort(files: RepoFiles, paths: readonly string[], patterns: RegExp[]): number | null {
  for (const path of paths) {
    const text = files.read(path);
    if (!text) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      const port = Number(match?.[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  }
  return null;
}

/** `/healthz` or `/health` if a source file mentions it as a route. */
function findHealthPath(files: RepoFiles, paths: readonly string[]): string | null {
  for (const candidate of ['/healthz', '/health']) {
    const quoted = new RegExp(`["'\`]${candidate}["'\`]`);
    if (paths.some((p) => quoted.test(files.read(p) ?? ''))) return candidate;
  }
  return null;
}

/**
 * Works out the stack, port, health endpoint, and what already exists, from file contents
 * only (nothing is run). Unsupported layouts return a reason instead of a guess.
 */
export function detectStack(files: RepoFiles, repoName: string): DetectResult {
  const base = { name: chartName(repoName), existing: existing(files) };
  if (has(files, 'pom.xml') || has(files, 'build.gradle') || has(files, 'build.gradle.kts')) {
    return detectSpring(files, base);
  }
  if (has(files, 'package.json')) return detectNode(files, base);
  if (has(files, 'go.mod')) return detectGo(files, base);
  if (has(files, 'requirements.txt') || has(files, 'pyproject.toml')) {
    return detectPython(files, base);
  }
  return {
    ok: false,
    reason:
      'No supported stack found. Supported: Spring Boot (Maven or Gradle), Node.js, Python, Go.',
  };
}

type Base = Pick<Detection, 'name' | 'existing'>;

function detectSpring(files: RepoFiles, base: Base): DetectResult {
  const maven = has(files, 'pom.xml');
  const buildFile = maven
    ? 'pom.xml'
    : has(files, 'build.gradle.kts')
      ? 'build.gradle.kts'
      : 'build.gradle';
  const build = files.read(buildFile) ?? '';
  if (!/spring-boot|org\.springframework\.boot/.test(build)) {
    return {
      ok: false,
      reason: `${buildFile} is not a Spring Boot build. Only Spring Boot is supported for Java.`,
    };
  }
  const notes: string[] = [];
  const declared =
    /<java\.version>\s*(\d+)\s*</.exec(build)?.[1] ??
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(build)?.[1] ??
    /JavaVersion\.VERSION_(\d+)/.exec(build)?.[1] ??
    /sourceCompatibility\s*=\s*['"]?(\d+)/.exec(build)?.[1];
  let version: JavaVersion = 21;
  if (declared !== undefined) {
    const n = Number(declared);
    if (!JAVA_VERSIONS.includes(n as JavaVersion)) {
      return {
        ok: false,
        reason: `Java ${declared} is not supported yet. Supported: ${JAVA_VERSIONS.join(', ')}.`,
      };
    }
    version = n as JavaVersion;
    notes.push(`Java ${declared}, from ${buildFile}.`);
  } else {
    notes.push('Java 21: no Java version is declared in the build.');
  }

  const config = files.paths.filter((p) =>
    /(^|\/)src\/main\/resources\/application(-default)?\.(properties|ya?ml)$/.test(p),
  );
  const declaredPort = findPort(files, config, [
    /^\s*server\.port\s*[=:]\s*(\d+)/m,
    /server:\s*\n(?:\s+#.*\n)*\s+port:\s*(\d+)/,
  ]);
  const port = declaredPort ?? 8080;
  notes.push(
    declaredPort
      ? `Port ${String(port)}, from server.port.`
      : 'Port 8080, the Spring Boot default.',
  );

  const actuator = build.includes('spring-boot-starter-actuator');
  notes.push(
    actuator
      ? 'Health checks use /actuator/health (Actuator is a dependency).'
      : 'Health checks use a TCP check: add Actuator for an HTTP health endpoint.',
  );
  return {
    ok: true,
    detection: {
      ...base,
      stack: maven ? 'spring-maven' : 'spring-gradle',
      port,
      healthPath: actuator ? '/actuator/health' : null,
      java: { version },
      notes: [`Spring Boot with ${maven ? 'Maven' : 'Gradle'}.`, ...notes],
    },
  };
}

interface PackageJson {
  main?: unknown;
  scripts?: Record<string, unknown>;
}

const sourceFiles = (files: RepoFiles, ext: RegExp) =>
  files.paths
    .filter((p) => ext.test(p) && !/(^|\/)(node_modules|dist|build|vendor|test|tests)\//.test(p))
    .slice(0, 200);

function detectNode(files: RepoFiles, base: Base): DetectResult {
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    if (has(files, lock)) {
      return {
        ok: false,
        reason: `Found ${lock}: only npm projects are supported for Node.js so far.`,
      };
    }
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(files.read('package.json') ?? '') as PackageJson;
  } catch {
    return { ok: false, reason: 'package.json is not valid JSON.' };
  }
  const scripts = pkg.scripts ?? {};
  const startScript = typeof scripts['start'] === 'string' ? scripts['start'] : undefined;
  const direct = startScript ? /^node\s+([\w./-]+)$/.exec(startScript.trim()) : null;
  let start: string[];
  const notes = ['Node.js with npm.'];
  if (direct?.[1]) {
    start = ['node', direct[1]];
    notes.push(`Runs \`node ${direct[1]}\`, from the start script.`);
  } else if (startScript) {
    start = ['npm', 'start'];
    notes.push('Runs `npm start`.');
  } else if (typeof pkg.main === 'string') {
    start = ['node', pkg.main];
    notes.push(`Runs \`node ${pkg.main}\`, from main in package.json.`);
  } else {
    return {
      ok: false,
      reason: 'package.json has no start script or main entry, so there is nothing to run.',
    };
  }
  const build = typeof scripts['build'] === 'string';
  if (build) notes.push('Runs `npm run build` in the build stage.');
  const install = has(files, 'package-lock.json') ? 'ci' : 'install';
  if (install === 'install') notes.push('No package-lock.json: installs with `npm install`.');

  const sources = sourceFiles(files, /\.(c|m)?(j|t)s$/);
  const declaredPort = findPort(files, sources, [
    /PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/,
    /\.listen\(\s*(\d{2,5})/,
  ]);
  const port = declaredPort ?? 3000;
  notes.push(
    declaredPort ? `Port ${String(port)}, from the source.` : 'Port 3000, a common default.',
  );
  const healthPath = findHealthPath(files, sources);
  notes.push(healthPath ? `Health checks use ${healthPath}.` : 'Health checks use a TCP check.');
  return {
    ok: true,
    detection: { ...base, stack: 'node', port, healthPath, node: { install, build, start }, notes },
  };
}

function detectPython(files: RepoFiles, base: Base): DetectResult {
  if (!has(files, 'requirements.txt')) {
    return {
      ok: false,
      reason: 'Found pyproject.toml without requirements.txt: only requirements.txt is supported.',
    };
  }
  const requirements = (files.read('requirements.txt') ?? '').toLowerCase();
  const dep = (name: string) => new RegExp(`^\\s*${name}\\b`, 'm').test(requirements);
  const sources = sourceFiles(files, /\.py$/);
  const notes = ['Python with requirements.txt.'];

  const app = (framework: 'FastAPI' | 'Flask') => {
    for (const path of sources) {
      const match = new RegExp(`^(\\w+)\\s*=\\s*${framework}\\(`, 'm').exec(files.read(path) ?? '');
      if (match?.[1]) {
        return `${path.replace(/\.py$/, '').replaceAll('/', '.')}:${match[1]}`;
      }
    }
    return null;
  };

  let cmd: string[];
  let port = 8000;
  if (dep('fastapi')) {
    const target = app('FastAPI');
    if (!target)
      return { ok: false, reason: 'FastAPI is a dependency, but no `app = FastAPI()` was found.' };
    if (!dep('uvicorn')) {
      return { ok: false, reason: 'FastAPI needs a server: add uvicorn to requirements.txt.' };
    }
    cmd = ['uvicorn', target, '--host', '0.0.0.0', '--port', String(port)];
    notes.push(`FastAPI app ${target}, served by uvicorn on port ${String(port)}.`);
  } else if (dep('flask')) {
    const target = app('Flask');
    if (!target)
      return { ok: false, reason: 'Flask is a dependency, but no `app = Flask()` was found.' };
    if (!dep('gunicorn')) {
      return {
        ok: false,
        reason: 'Flask needs a production server: add gunicorn to requirements.txt.',
      };
    }
    cmd = ['gunicorn', '--bind', `0.0.0.0:${String(port)}`, target];
    notes.push(`Flask app ${target}, served by gunicorn on port ${String(port)}.`);
  } else if (dep('django')) {
    return { ok: false, reason: 'Django is not supported yet.' };
  } else {
    const entry = ['main.py', 'app.py', 'server.py'].find((p) => has(files, p));
    if (!entry) return { ok: false, reason: 'No main.py, app.py, or server.py to run.' };
    port =
      findPort(files, [entry], [/port\s*=\s*(\d{2,5})/i, /PORT['"]?\s*,\s*['"]?(\d{2,5})/]) ?? port;
    cmd = ['python', entry];
    notes.push(`Runs \`python ${entry}\` on port ${String(port)}.`);
  }
  const healthPath = findHealthPath(files, sources);
  notes.push(healthPath ? `Health checks use ${healthPath}.` : 'Health checks use a TCP check.');
  return {
    ok: true,
    detection: { ...base, stack: 'python', port, healthPath, python: { cmd }, notes },
  };
}

function detectGo(files: RepoFiles, base: Base): DetectResult {
  const goFiles = files.paths.filter((p) => p.endsWith('.go') && !p.endsWith('_test.go'));
  const isMain = (p: string) => /^package\s+main\b/m.test(files.read(p) ?? '');
  let pkg: string;
  if (goFiles.some((p) => !p.includes('/') && isMain(p))) {
    pkg = '.';
  } else {
    const cmds = [
      ...new Set(
        goFiles
          .filter((p) => /^cmd\/[^/]+\/[^/]+\.go$/.test(p) && isMain(p))
          .map((p) => `./${p.split('/').slice(0, 2).join('/')}`),
      ),
    ];
    if (cmds.length !== 1 || !cmds[0]) {
      return {
        ok: false,
        reason:
          cmds.length === 0
            ? 'No main package found at the root or under cmd/.'
            : `Several main packages under cmd/ (${cmds.join(', ')}): ship one service per repo.`,
      };
    }
    pkg = cmds[0];
  }
  const sources = goFiles.slice(0, 200);
  const declaredPort = findPort(files, sources, [
    /ListenAndServe\(\s*"[^"]*:(\d{2,5})"/,
    /Getenv\("PORT"\)[\s\S]{0,120}?"(\d{2,5})"/,
    /"(?:0\.0\.0\.0)?:(\d{2,5})"/,
  ]);
  const port = declaredPort ?? 8080;
  const healthPath = findHealthPath(files, sources);
  return {
    ok: true,
    detection: {
      ...base,
      stack: 'go',
      port,
      healthPath,
      go: { pkg },
      notes: [
        pkg === '.' ? 'Go, main package at the repo root.' : `Go, main package ${pkg}.`,
        declaredPort ? `Port ${String(port)}, from the source.` : 'Port 8080, a common default.',
        healthPath ? `Health checks use ${healthPath}.` : 'Health checks use a TCP check.',
      ],
    },
  };
}
