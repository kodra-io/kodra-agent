import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectors } from '@kodra-agent/connectors';
import { stdioRuntimes } from '@kodra-agent/schema';
import { fetchServer, mcpCacheDir, preinstalledPath } from '../src/mcp/fetch.ts';
import { lockfileFor, lockfileProblem } from '../src/mcp/preinstall.ts';

// Installs every pinned MCP server into KODRA_MCP_DIR, for the agent image:
//   release binaries, checksum-verified;
//   PyPI servers from hash-locked requirements (uv, --require-hashes, no other dependencies);
//   npm servers from their package-lock.json (npm ci, no install scripts).
// Fails on a missing or stale lockfile, so the image never runs an unpinned server.
const dir = mcpCacheDir();
const python = process.env['KODRA_PYTHON'] ?? 'python3';
const run = (command: string, args: string[], cwd?: string) => {
  execFileSync(command, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
};

const done = new Set<string>();
for (const manifest of connectors) {
  for (const runtime of stdioRuntimes(manifest)) {
    const source = runtime.source;
    const key = JSON.stringify(source);
    if (done.has(key)) continue;
    done.add(key);
    const label = `${manifest.id}${runtime.name ? `/${runtime.name}` : ''}`;

    if (source.kind === 'github-release') {
      const result = await fetchServer(runtime, dir);
      console.log(
        `${label}: ${result.status}${'path' in result ? ` ${result.path}` : ` (${result.reason})`}`,
      );
      if (result.status === 'skipped') throw new Error(`${label}: ${result.reason}`);
      continue;
    }

    const problem = lockfileProblem(runtime);
    if (problem) throw new Error(`${label}: ${problem}`);
    const lock = lockfileFor(runtime) ?? '';
    const exe = preinstalledPath(runtime, dir) ?? '';
    if (source.kind === 'pypi') {
      const venv = dirname(dirname(exe));
      run('uv', ['venv', '--quiet', '--python', python, venv]);
      run('uv', [
        'pip',
        'install',
        '--quiet',
        '--python',
        join(venv, 'bin', 'python'),
        '--require-hashes',
        '--no-deps',
        '-r',
        lock,
      ]);
    } else {
      const folder = dirname(dirname(dirname(exe)));
      mkdirSync(folder, { recursive: true });
      for (const file of ['package.json', 'package-lock.json']) {
        copyFileSync(join(lock, file), join(folder, file));
      }
      run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], folder);
    }
    if (!existsSync(exe)) throw new Error(`${label}: ${exe} was not installed`);
    console.log(`${label}: installed ${exe}`);
  }
}
