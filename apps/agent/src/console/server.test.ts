import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers.ts';
import { CONSOLE_CSP, startConsoleServer } from './server.ts';

const TOKEN = 'console-token-for-tests-7c1e9b2a'; // gitleaks:allow
let server: Server | undefined;
afterEach(async () => {
  const running = server;
  if (running) {
    await new Promise<void>((r) => {
      running.close(() => {
        r();
      });
    });
  }
  server = undefined;
});

async function start(opts: { staticDir?: string } = {}) {
  const dir = opts.staticDir ?? (await tempDir());
  if (!opts.staticDir) {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>console</title>');
    await writeFile(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  }
  server = await startConsoleServer({
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    staticDir: dir,
    routes: { status: () => ({ ok: true }), echo: (q) => ({ q: q.get('x') }) },
  });
  const address = server.address();
  const base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  const login = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ token }),
    });
  return { base, dir, login };
}

const sessionCookie = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describe('console server', () => {
  it('needs a sign-in, then serves the API with a session cookie', async () => {
    const { base, login } = await start();
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ signedIn: false });

    expect((await login('wrong')).status).toBe(401);
    const ok = await login(TOKEN);
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(
      /^kodra_console=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/;/,
    );
    expect(setCookie).not.toContain(TOKEN);

    const cookie = sessionCookie(ok);
    const res = await fetch(`${base}/api/echo?x=1`, { headers: { cookie } });
    expect(await res.json()).toEqual({ q: '1' });
    expect(res.headers.get('cache-control')).toBe('no-store');

    await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
  });

  it('limits failed sign-ins and refuses cross-origin posts', async () => {
    const { login } = await start();
    for (let i = 0; i < 10; i++) expect((await login('nope')).status).toBe(401);
    expect((await login(TOKEN)).status).toBe(429);

    const other = await start();
    expect((await other.login(TOKEN, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('is read-only', async () => {
    const { base, login } = await start();
    const cookie = sessionCookie(await login(TOKEN));
    expect((await fetch(`${base}/api/status`, { method: 'PUT', headers: { cookie } })).status).toBe(
      405,
    );
    expect(
      (await fetch(`${base}/api/status`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(404);
  });

  it('serves the app with strict headers, assets cached, and never files outside it', async () => {
    const { base } = await start();
    const page = await fetch(`${base}/activity`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>console</title>');
    expect(page.headers.get('content-security-policy')).toBe(CONSOLE_CSP);
    expect(CONSOLE_CSP).toContain("connect-src 'self'");
    expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`${base}/assets/app-abc.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    for (const path of [
      '/../package.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%5c..%5cpackage.json',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text()).toContain('<title>console</title>');
    }
  });

  it('says how to build the console when it is missing', async () => {
    const { base } = await start({ staticDir: join(await tempDir(), 'no-build') });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('pnpm --filter @kodra-agent/console build');
  });
});
