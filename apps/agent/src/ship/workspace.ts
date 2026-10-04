import { readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RepoFiles, SourceProvider } from '@kodra-agent/templates';
import type { Redactor } from '../redactor.ts';
import type { Exec, ExecResult } from './exec.ts';

/** Folders that never matter for detection and are not copied from a local checkout. */
const SKIP = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vscode',
]);
const MAX_FILES = 5000;
const MAX_READ = 512 * 1024;

/** A read-only view of a checkout for stack detection. */
export function repoFiles(dir: string): RepoFiles {
  const paths: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (paths.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(join(folder, entry.name));
      } else if (entry.isFile()) {
        paths.push(relative(dir, join(folder, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return {
    paths: paths.sort(),
    read: (path) => {
      try {
        const full = join(dir, ...path.split('/'));
        return statSync(full).size > MAX_READ ? undefined : readFileSync(full, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Copies a local folder for verification, leaving out .git, dependencies, and build output. */
export async function copyLocal(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (source) => !SKIP.has(source.split(/[\\/]/).at(-1) ?? ''),
  });
}

export const AUTHOR = { name: 'Kodra AI Agent', email: 'kodra-agent@users.noreply.kodra.io' };

/**
 * Git with the user's own config and hooks switched off, and the token passed as an HTTP
 * header through environment variables: never in arguments, URLs, or .git/config.
 */
export class Git {
  private readonly exec: Exec;
  private readonly env: Record<string, string>;

  private constructor(exec: Exec, env: Record<string, string>) {
    this.exec = exec;
    this.env = env;
  }

  /** `emptyConfig` is an empty file used as the global git config. */
  static create(opts: {
    exec: Exec;
    redactor: Redactor;
    emptyConfig: string;
    provider?: SourceProvider;
    token?: string;
  }): Git {
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: opts.emptyConfig,
    };
    if (opts.provider && opts.token) {
      const user = opts.provider === 'github' ? 'x-access-token' : 'oauth2';
      const basic = Buffer.from(`${user}:${opts.token}`, 'utf8').toString('base64');
      opts.redactor.add(basic);
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      });
    }
    return new Git(opts.exec, env);
  }

  run(args: readonly string[], cwd?: string, timeoutMs = 5 * 60_000): Promise<ExecResult> {
    return this.exec('git', args, { ...(cwd ? { cwd } : {}), env: this.env, timeoutMs });
  }
}

export async function writeEmptyFile(path: string): Promise<string> {
  await writeFile(path, '', { mode: 0o600 });
  return path;
}

/** The HTTPS clone address of a configured repo. */
export function remoteUrl(provider: SourceProvider, repo: string, gitlabUrl?: string): string {
  if (provider === 'github') return `https://github.com/${repo}.git`;
  return `${(gitlabUrl ?? 'https://gitlab.com').replace(/\/+$/, '')}/${repo}.git`;
}
