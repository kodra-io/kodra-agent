import type { Component } from './config.ts';
import type { LookupOptions } from './default-branches.ts';

/** A file's text at a ref, or null when it does not exist there. Throws on other failures. */
export type FileReader = (repo: string, path: string, ref: string) => Promise<string | null>;

/** Files larger than this are not previewed (and a change to them is refused). */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Reads files from the connector's forge with one read-only call each, for the diff in a
 * proposed change and the check before each write. Uses the same token and API as the
 * default-branch lookup; never writes.
 */
export function forgeFileReader(
  component: Component,
  token: string | undefined,
  opts: LookupOptions,
): FileReader | undefined {
  const kind = component.manifest.defaultBranchLookup;
  if (!kind) return undefined;
  return async (repo, path, ref) => {
    let url: string;
    let headers: Record<string, string>;
    const cleanPath = path.replace(/^\/+/, '');
    if (kind === 'github') {
      const api = (opts.githubApi ?? 'https://api.github.com').replace(/\/+$/, '');
      const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
      url = `${api}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
      headers = {
        accept: 'application/vnd.github.raw+json',
        'x-github-api-version': '2026-03-10',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
    } else {
      const base =
        typeof component.settings['url'] === 'string'
          ? component.settings['url']
          : 'https://gitlab.com';
      url = `${base.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(cleanPath)}/raw?ref=${encodeURIComponent(ref)}`;
      headers = token ? { 'private-token': token } : {};
    }
    const res = await opts.fetch(url, {
      headers: { 'user-agent': 'kodra-agent', ...headers },
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'error',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`could not read ${path} at ${ref}: HTTP ${String(res.status)}`);
    const size = Number(res.headers.get('content-length') ?? '0');
    if (size > MAX_FILE_BYTES) throw new Error(`${path} is too large to preview`);
    const text = await res.text();
    if (text.length > MAX_FILE_BYTES) throw new Error(`${path} is too large to preview`);
    return text;
  };
}
