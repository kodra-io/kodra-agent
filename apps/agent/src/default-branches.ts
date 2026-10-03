import type { Component } from './config.ts';

export interface LookupOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Overrides the public GitHub API host (tests). */
  githubApi?: string | undefined;
}

/**
 * Looks up each configured repo's default branch with one read-only call, so the policy
 * engine can block writes to it (golden rule 6). A failed lookup is stored as null, which
 * blocks writes to that repo rather than guessing. Keys are lowercase repo paths.
 */
export async function lookupDefaultBranches(
  component: Component,
  token: string | undefined,
  opts: LookupOptions,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const kind = component.manifest.defaultBranchLookup;
  if (!kind) return out;
  const key = kind === 'github' ? 'repos' : 'projects';
  const repos = Array.isArray(component.settings[key])
    ? (component.settings[key] as unknown[]).map(String)
    : [];

  for (const repo of repos) {
    let url: string;
    let headers: Record<string, string>;
    if (kind === 'github') {
      url = `${(opts.githubApi ?? 'https://api.github.com').replace(/\/+$/, '')}/repos/${repo}`;
      headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
    } else {
      const base =
        typeof component.settings['url'] === 'string'
          ? component.settings['url']
          : 'https://gitlab.com';
      url = `${base.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(repo)}`;
      headers = token ? { 'private-token': token } : {};
    }
    out.set(repo.toLowerCase(), await fetchDefaultBranch(url, headers, opts));
  }
  return out;
}

async function fetchDefaultBranch(
  url: string,
  headers: Record<string, string>,
  opts: LookupOptions,
): Promise<string | null> {
  try {
    const res = await opts.fetch(url, {
      headers: { 'user-agent': 'kodra-agent', ...headers },
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' && body.default_branch !== ''
      ? body.default_branch
      : null;
  } catch {
    return null;
  }
}
