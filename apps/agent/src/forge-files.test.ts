import { getConnector } from '@kodra-agent/connectors';
import { afterEach, describe, expect, it } from 'vitest';
import type { Component } from './config.ts';
import { forgeFileReader } from './forge-files.ts';
import { fakeServer } from './test-helpers.ts';

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

describe('forgeFileReader', () => {
  it('reads a GitHub file raw at a ref, with the token, and returns null when missing', async () => {
    server = await fakeServer({
      '/repos/acme/api/contents/deploy/values.yaml': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('replicas: 2\n');
        expect(req.headers.accept).toBe('application/vnd.github.raw+json');
      },
    });
    const read = forgeFileReader(component('github', { repos: ['acme/api'] }), 'gh-token', {
      fetch: globalThis.fetch,
      timeoutMs: 2000,
      githubApi: server.url,
    });
    expect(await read?.('acme/api', '/deploy/values.yaml', 'main')).toBe('replicas: 2\n');
    expect(await read?.('acme/api', 'missing.txt', 'main')).toBeNull();
    expect(server.requests[0]?.url).toBe('/repos/acme/api/contents/deploy/values.yaml?ref=main');
    expect(server.requests[0]?.headers.authorization).toBe('Bearer gh-token');
  });

  it('reads a GitLab file by encoded project and path from the configured address', async () => {
    server = await fakeServer({
      '/api/v4/projects/group%2Fapp/repository/files/charts%2Fvalues.yaml/raw': (req, res) => {
        res.writeHead(200).end('image: a\n');
        expect(req.headers['private-token']).toBe('gl-token');
      },
    });
    const read = forgeFileReader(
      component('gitlab', { projects: ['group/app'], url: server.url }),
      'gl-token',
      { fetch: globalThis.fetch, timeoutMs: 2000 },
    );
    expect(await read?.('group/app', 'charts/values.yaml', 'fix/x')).toBe('image: a\n');
    expect(server.requests[0]?.url).toContain('/raw?ref=fix%2Fx');
  });

  it('fails on other errors and on files too large to preview', async () => {
    server = await fakeServer({
      '/repos/acme/api/contents/big.bin': (_req, res) => {
        res.writeHead(200).end('x'.repeat(1024 * 1024 + 1));
      },
      '/repos/acme/api/contents/secret.txt': (_req, res) => {
        res.writeHead(403).end();
      },
    });
    const read = forgeFileReader(component('github', { repos: ['acme/api'] }), 't', {
      fetch: globalThis.fetch,
      timeoutMs: 2000,
      githubApi: server.url,
    });
    await expect(read?.('acme/api', 'big.bin', 'main')).rejects.toThrow('too large to preview');
    await expect(read?.('acme/api', 'secret.txt', 'main')).rejects.toThrow('HTTP 403');
  });

  it('is not offered for connectors without a forge', () => {
    expect(
      forgeFileReader(component('kubernetes', { namespaces: ['a'] }), undefined, {
        fetch: globalThis.fetch,
        timeoutMs: 1,
      }),
    ).toBeUndefined();
  });
});
