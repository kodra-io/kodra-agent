import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectors, getConnector } from '@kodra-agent/connectors';
import { stdioRuntimes, type McpStdioRuntime } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers.ts';
import { preinstalledPath } from './fetch.ts';
import { defaultLauncher } from './host.ts';
import { lockfileProblem } from './preinstall.ts';

const runtimes = connectors.flatMap((m) =>
  stdioRuntimes(m).map((r) => [`${m.id}${r.name ? `/${r.name}` : ''}`, r] as const),
);

function manifest(id: string) {
  const found = getConnector(id);
  if (!found) throw new Error(`unknown connector ${id}`);
  return found;
}

const pypi: McpStdioRuntime = {
  type: 'mcp-stdio',
  source: { kind: 'pypi', package: 'demo.server', version: '1.2.3', command: 'demo-server' },
  args: [],
  env: {},
};

describe('MCP lockfiles for the agent image', () => {
  it.each(runtimes)('%s has a lockfile pinning the manifest version', (_id, runtime) => {
    expect(lockfileProblem(runtime)).toBeNull();
  });

  it('notices a lockfile that pins another version or has no hashes', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'pypi'));
    expect(lockfileProblem(pypi, dir)).toMatch(/^missing /);
    await writeFile(
      join(dir, 'pypi', 'demo.server.txt'),
      'demo-server==1.2.2 \\\n    --hash=sha256:aa\n',
    );
    expect(lockfileProblem(pypi, dir)).toMatch(/does not pin demo.server==1.2.3$/);
    await writeFile(
      join(dir, 'pypi', 'demo.server.txt'),
      'demo-server==1.2.3 \\\n    --hash=sha256:aa\nidna==3.10\n',
    );
    expect(lockfileProblem(pypi, dir)).toMatch(/requirement without hashes$/);
  });

  it('notices a stale npm lock', async () => {
    const [gitlab] = stdioRuntimes(manifest('gitlab'));
    if (!gitlab) throw new Error('no GitLab server');
    const dir = await tempDir();
    const folder = join(dir, 'npm', 'zereight__mcp-gitlab');
    await mkdir(folder, { recursive: true });
    const source = gitlab.source as { package: string; version: string };
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({ dependencies: { [source.package]: source.version } }),
    );
    await writeFile(
      join(folder, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${source.package}`]: { version: '0.0.1' } } }),
    );
    expect(lockfileProblem(gitlab, dir)).toMatch(/is stale/);
  });
});

describe('defaultLauncher', () => {
  it('runs a preinstalled server when the image has one, else uvx at the pinned version', async () => {
    const dir = await tempDir();
    const launch = defaultLauncher({ KODRA_MCP_DIR: dir });
    const prometheus = manifest('prometheus');
    expect(launch(prometheus, pypi)).toEqual({
      command: 'uvx',
      args: ['--from', 'demo.server==1.2.3', 'demo-server'],
    });
    const exe = preinstalledPath(pypi, dir) ?? '';
    expect(exe).toBe(join(dir, 'pypi', 'demo.server', '1.2.3', 'bin', 'demo-server'));
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, '');
    expect(launch(prometheus, pypi)).toEqual({ command: exe, args: [] });
  });
});
