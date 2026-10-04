import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpStdioRuntime } from '@kodra-agent/schema';

/** Lockfiles the agent image installs servers from (committed in docker/mcp). */
export const LOCK_DIR = fileURLToPath(new URL('../../../../docker/mcp/', import.meta.url));

/** PEP 503 name normalization: `awslabs.eks-mcp-server` -> `awslabs-eks-mcp-server`. */
const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

export const npmFolder = (pkg: string) => pkg.replace(/^@/, '').replace('/', '__');

/** The lockfile (pypi) or lock folder (npm) for a server, or null for release binaries. */
export function lockfileFor(runtime: McpStdioRuntime, lockDir = LOCK_DIR): string | null {
  const source = runtime.source;
  if (source.kind === 'pypi') return join(lockDir, 'pypi', `${source.package}.txt`);
  if (source.kind === 'npm') return join(lockDir, 'npm', npmFolder(source.package));
  return null;
}

/**
 * Why a server's lockfile cannot be used, or null if it pins the manifest's version.
 * Keeps a manifest version bump from shipping an image with the old server.
 */
export function lockfileProblem(runtime: McpStdioRuntime, lockDir = LOCK_DIR): string | null {
  const source = runtime.source;
  const lock = lockfileFor(runtime, lockDir);
  if (!lock) return null;
  if (source.kind === 'pypi') {
    if (!existsSync(lock)) return `missing ${lock}`;
    const text = readFileSync(lock, 'utf8');
    const pinned = text.split('\n').some((line) => {
      const [name = '', rest = ''] = line.split('==');
      return pypiName(name) === pypiName(source.package) && rest.split(/\s/)[0] === source.version;
    });
    if (!pinned) return `${lock} does not pin ${source.package}==${source.version}`;
    if (/^[a-z0-9][^\s=]*==\S+\s*$/im.test(text)) return `${lock} has a requirement without hashes`;
    return null;
  }
  if (source.kind === 'npm') {
    const pkgPath = join(lock, 'package.json');
    const lockPath = join(lock, 'package-lock.json');
    if (!existsSync(pkgPath) || !existsSync(lockPath))
      return `missing package.json or package-lock.json in ${lock}`;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.[source.package] !== source.version) {
      return `${pkgPath} does not pin ${source.package} ${source.version}`;
    }
    const locked = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    if (locked.packages?.[`node_modules/${source.package}`]?.version !== source.version) {
      return `${lockPath} is stale: run npm install --package-lock-only in ${lock}`;
    }
  }
  return null;
}
