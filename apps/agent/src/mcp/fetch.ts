import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Manifest, McpStdioRuntime, Platform } from '@kodra-agent/schema';

const run = promisify(execFile);

/** Where pinned server binaries live: KODRA_MCP_DIR, or .cache/mcp at the repo root. */
export function mcpCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolve(
    env['KODRA_MCP_DIR'] ?? fileURLToPath(new URL('../../../../.cache/mcp', import.meta.url)),
  );
}

export function currentPlatform(): Platform | null {
  const key = `${platform()}-${arch()}`;
  const known: Record<string, Platform> = {
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64',
  };
  return known[key] ?? null;
}

/** The executable a github-release server runs from, whether or not it is installed yet. */
export function binaryPath(
  manifest: Manifest,
  runtime: McpStdioRuntime,
  cacheDir: string,
): string | null {
  const source = runtime.source;
  if (source.kind !== 'github-release') return null;
  const target = currentPlatform();
  const asset = target ? source.assets[target] : undefined;
  if (!asset) return null;
  return join(cacheDir, manifest.id, source.version, asset.binary);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export type FetchResult =
  { status: 'installed' | 'present'; path: string } | { status: 'skipped'; reason: string };

/**
 * Downloads a pinned server binary for this platform and refuses it unless its SHA-256
 * matches the manifest. Archives are unpacked with the system `tar` (also handles zip on
 * Windows 10+ and macOS).
 */
export async function fetchServer(
  manifest: Manifest,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
  const runtime = manifest.runtime;
  if (runtime?.type !== 'mcp-stdio') return { status: 'skipped', reason: 'no MCP server' };
  const source = runtime.source;
  if (source.kind !== 'github-release')
    return { status: 'skipped', reason: `runs with ${source.kind}` };
  const target = currentPlatform();
  const asset = target ? source.assets[target] : undefined;
  if (!target || !asset)
    return { status: 'skipped', reason: `no build for ${platform()}-${arch()}` };

  const dir = join(cacheDir, manifest.id, source.version);
  const exe = join(dir, asset.binary);
  if (await exists(exe)) return { status: 'present', path: exe };

  const url = `https://github.com/${source.repo}/releases/download/${source.version}/${asset.file}`;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${String(res.status)} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== asset.sha256) {
    throw new Error(`checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${sha}`);
  }

  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const download = join(staging, asset.file);
  await writeFile(download, bytes);
  if (asset.archive !== 'none') {
    // On Windows, use the built-in bsdtar: a GNU tar from Git Bash may come first on PATH,
    // and it reads "C:" as a remote host and cannot unpack zip files.
    const tar =
      platform() === 'win32'
        ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    await run(tar, ['-xf', download, '-C', staging]);
    await rm(download);
  }
  await chmod(join(staging, asset.binary), 0o755);
  await mkdir(dirname(dir), { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  return { status: 'installed', path: exe };
}
