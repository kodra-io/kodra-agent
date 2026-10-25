import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_CONTENT_SECURITY_POLICY } from '../src/csp.ts';
import { checkDeploy } from './deploy-check.ts';

/**
 * pnpm check:deploy against a stand-in for the Build site: dist/ under /agent/, the redirect
 * and rewrite of the viewer-request function, and the headers of the viewer-response function
 * (terraform: Modules/cloudfront/functions). With `headers: false` it is a broken deploy.
 */
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

function buildSite(opts: {
  headers: boolean;
  csp?: string;
}): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/') {
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><body>Kodra Build</body></html>');
        return;
      }
      if (path === '/agent' && opts.headers) {
        res.writeHead(301, { location: '/agent/' }).end();
        return;
      }
      if (!path.startsWith('/agent/')) {
        res.writeHead(404).end();
        return;
      }
      const last = path.slice(path.lastIndexOf('/') + 1);
      const file = last === '' || !last.includes('.') ? 'index.html' : path.slice('/agent/'.length);
      const body = await readFile(join(DIST, file)).catch(() => null);
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        ...(opts.headers
          ? {
              'content-security-policy': opts.csp ?? HEADER_CONTENT_SECURITY_POLICY,
              'x-frame-options': 'DENY',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
            }
          : {}),
      });
      res.end(body);
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`,
        server,
      });
    });
  });
}

test.describe('pnpm check:deploy (L4)', () => {
  test('passes a deploy that matches docs/configurator-deploy.md', async () => {
    const { url, server } = await buildSite({ headers: true });
    try {
      const results = await checkDeploy(url);
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results.map((r) => r.check)).toEqual([
        'redirect',
        'page',
        'csp header',
        'frame options',
        'nosniff',
        'referrer policy',
        'hsts',
        'bundle',
        'no outside requests',
        'no console errors',
        'build home',
      ]);
    } finally {
      server.close();
    }
  });

  test('names what is wrong: no redirect, no headers, or a CSP that drifted', async () => {
    const bare = await buildSite({ headers: false });
    try {
      const failed = (await checkDeploy(bare.url)).filter((r) => !r.ok).map((r) => r.check);
      expect(failed).toEqual([
        'redirect',
        'csp header',
        'frame options',
        'nosniff',
        'referrer policy',
      ]);
    } finally {
      bare.server.close();
    }
    const drifted = await buildSite({
      headers: true,
      csp: HEADER_CONTENT_SECURITY_POLICY.replace("connect-src 'none'", "connect-src 'self'"),
    });
    try {
      const csp = (await checkDeploy(drifted.url)).find((r) => r.check === 'csp header');
      expect(csp).toEqual({
        check: 'csp header',
        ok: false,
        detail: "missing: connect-src 'none'; extra: connect-src 'self'",
      });
    } finally {
      drifted.server.close();
    }
  });
});
