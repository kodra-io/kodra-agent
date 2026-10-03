import { getConnector } from '@kodra-agent/connectors';
import { afterEach, describe, expect, it } from 'vitest';
import type { Component } from './config.ts';
import { lookupDefaultBranches } from './default-branches.ts';
import { fakeServer, json } from './test-helpers.ts';

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function component(id: string, settings: Record<string, unknown>): Component {
  const manifest = getConnector(id);
  if (!manifest) throw new Error(id);
  return { id, displayName: manifest.displayName, manifest, settings, secrets: [] };
}

describe('lookupDefaultBranches', () => {
  it('reads each GitHub repo once with the token, and stores failures as null', async () => {
    server = await fakeServer({
      '/repos/acme/api': (_q, s) => {
        json(s, 200, { default_branch: 'main' });
      },
      '/repos/Acme/Web': (_q, s) => {
        json(s, 200, { default_branch: 'trunk' });
      },
      '/repos/acme/gone': (_q, s) => {
        json(s, 404, {});
      },
    });
    const branches = await lookupDefaultBranches(
      component('github', { repos: ['acme/api', 'Acme/Web', 'acme/gone'] }),
      'gh-token',
      { fetch: globalThis.fetch, timeoutMs: 2000, githubApi: server.url },
    );
    expect([...branches]).toEqual([
      ['acme/api', 'main'],
      ['acme/web', 'trunk'],
      ['acme/gone', null],
    ]);
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer gh-token',
      'Bearer gh-token',
      'Bearer gh-token',
    ]);
  });

  it('reads GitLab projects by URL-encoded path from the configured address', async () => {
    server = await fakeServer({
      '/api/v4/projects/acme%2Fplatform%2Fapi': (_q, s) => {
        json(s, 200, { default_branch: 'develop' });
      },
    });
    const branches = await lookupDefaultBranches(
      component('gitlab', { url: server.url, projects: ['acme/platform/api'] }),
      'gl-token',
      { fetch: globalThis.fetch, timeoutMs: 2000 },
    );
    expect([...branches]).toEqual([['acme/platform/api', 'develop']]);
    expect(server.requests[0]?.headers['private-token']).toBe('gl-token');
  });

  it('stores null when the server cannot be reached', async () => {
    const branches = await lookupDefaultBranches(
      component('github', { repos: ['acme/api'] }),
      't',
      { fetch: () => Promise.reject(new Error('offline')), timeoutMs: 2000 },
    );
    expect([...branches]).toEqual([['acme/api', null]]);
  });

  it('does nothing for connectors without a lookup', async () => {
    expect(
      (
        await lookupDefaultBranches(component('prometheus', {}), undefined, {
          fetch: globalThis.fetch,
          timeoutMs: 1,
        })
      ).size,
    ).toBe(0);
  });
});
