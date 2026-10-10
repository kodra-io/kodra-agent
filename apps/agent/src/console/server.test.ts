import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers.ts';
import {
  ACTION_HEADER,
  CONSOLE_CSP,
  Forbidden,
  SessionRegistry,
  startConsoleServer,
  type StreamRoute,
} from './server.ts';

const TOKEN = 'console-token-for-tests-7c1e9b2a'; // gitleaks:allow
const APPROVER_TOKEN = 'approver-token-for-tests-4d2f8e1c'; // gitleaks:allow
let server: Server | undefined;
afterEach(async () => {
  const running = server;
  if (running) {
    await new Promise<void>((r) => {
      running.close(() => {
        r();
      });
      running.closeAllConnections();
    });
  }
  server = undefined;
});

let streamStops = 0;
const ticker: StreamRoute = ({ query, lastEventId }, send) => {
  if (query.get('conversation') !== 'c1') return null;
  send(lastEventId + 1, { hello: 'world' });
  return () => {
    streamStops += 1;
  };
};

async function start(opts: { staticDir?: string; sessions?: SessionRegistry } = {}) {
  const dir = opts.staticDir ?? (await tempDir());
  if (!opts.staticDir) {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>console</title>');
    await writeFile(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  }
  server = await startConsoleServer({
    port: 0,
    host: '127.0.0.1',
    accounts: [
      { token: TOKEN, user: { name: 'console', canApprove: false } },
      { token: APPROVER_TOKEN, user: { name: 'console:omar', canApprove: true } },
    ],
    staticDir: dir,
    routes: {
      status: () => ({ ok: true }),
      echo: ({ query, user }) => ({ q: query.get('x'), user: user.name }),
      secret: ({ user }) => (user.canApprove ? { ok: true } : new Forbidden('approvers only')),
    },
    actions: { say: ({ user, body }) => ({ status: 200, body: { user: user.name, body } }) },
    streams: { 'chat/events': ticker },
    features: { chat: true },
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
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
      /^kodra_console=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/;/,
    );
    expect(setCookie).not.toContain(TOKEN);

    const cookie = sessionCookie(ok);
    const res = await fetch(`${base}/api/echo?x=1`, { headers: { cookie } });
    expect(await res.json()).toEqual({ q: '1', user: 'console' });
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toEqual({
      signedIn: true,
      user: 'console',
      canApprove: false,
      features: { chat: true },
    });
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

  it('keeps a session over a restart, and refuses a tampered or rotated one', async () => {
    const first = await start();
    const cookie = sessionCookie(await first.login(APPROVER_TOKEN));
    const [body = '', mac = ''] = cookie.slice('kodra_console='.length).split('.');
    // A new server with the same tokens (the agent restarted to apply settings).
    const again = await start();
    const ok = await fetch(`${again.base}/api/session`, { headers: { cookie } });
    expect(await ok.json()).toMatchObject({ signedIn: true, user: 'console:omar' });

    // Claiming another user, or a later expiry, breaks the signature.
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const change of [{ u: 'console' }, { e: Date.now() + 1e10 }]) {
      const tampered = Buffer.from(JSON.stringify({ ...forged, ...change })).toString('base64url');
      const res = await fetch(`${again.base}/api/session`, {
        headers: { cookie: `kodra_console=${tampered}.${mac}` },
      });
      expect(await res.json()).toEqual({ signedIn: false });
    }

    // A server whose approver token was rotated does not accept the old session.
    const rotated = await startConsoleServer({
      port: 0,
      host: '127.0.0.1',
      accounts: [
        { token: 'rotated-token-0a9b8c7d', user: { name: 'console:omar', canApprove: true } },
      ],
      routes: {},
      staticDir: first.dir,
    });
    const address = rotated.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/session`, {
      headers: { cookie },
    });
    expect(await res.json()).toEqual({ signedIn: false });
    await new Promise<void>((r) => {
      rotated.close(() => {
        r();
      });
    });
  });

  it('signs each approver in as themselves', async () => {
    const { base, login } = await start();
    const cookie = sessionCookie(await login(APPROVER_TOKEN));
    const session = (await (
      await fetch(`${base}/api/session`, { headers: { cookie } })
    ).json()) as {
      user: string;
      canApprove: boolean;
    };
    expect(session).toMatchObject({ user: 'console:omar', canApprove: true });
  });

  it('accepts an action only with a session, the header, and a small JSON object', async () => {
    const { base, login } = await start();
    const cookie = sessionCookie(await login(TOKEN));
    const say = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/api/say`, { method: 'POST', headers, body });
    const noHeader = { cookie, 'content-type': 'application/json' };
    const good = { ...noHeader, [ACTION_HEADER]: '1' };

    const ok = await say(good, JSON.stringify({ text: 'hi' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ user: 'console', body: { text: 'hi' } });

    expect((await say(noHeader, '{}')).status).toBe(403);
    expect((await say({ ...good, 'content-type': 'text/plain' }, '{}')).status).toBe(415);
    expect((await say({ ...good, cookie: 'kodra_console=nope' }, '{}')).status).toBe(401);
    expect((await say({ ...good, origin: 'https://evil.example' }, '{}')).status).toBe(403);
    expect((await say(good, '[1]')).status).toBe(400);
    expect((await say(good, JSON.stringify({ text: 'x'.repeat(17 * 1024) }))).status).toBe(400);
  });

  it('refuses unknown methods and routes', async () => {
    const { base, login } = await start();
    const cookie = sessionCookie(await login(TOKEN));
    expect((await fetch(`${base}/api/status`, { method: 'PUT', headers: { cookie } })).status).toBe(
      405,
    );
    expect(
      (await fetch(`${base}/api/status`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(404);
  });

  it('answers 403 when a read route says Forbidden', async () => {
    const { base, login } = await start();
    const viewer = sessionCookie(await login(TOKEN));
    const res = await fetch(`${base}/api/secret`, { headers: { cookie: viewer } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'approvers only' });
    const approver = sessionCookie(await login(APPROVER_TOKEN));
    expect(
      await (await fetch(`${base}/api/secret`, { headers: { cookie: approver } })).json(),
    ).toEqual({ ok: true });
  });

  it('lists who is signed in, and a sign-out from the list ends the session and its streams', async () => {
    const dir = await tempDir();
    const path = join(dir, 'console-sessions.json');
    const sessions = new SessionRegistry({ path });
    const { base, login } = await start({ sessions });
    const viewer = sessionCookie(await login(TOKEN));
    const approver = sessionCookie(await login(APPROVER_TOKEN));
    await fetch(`${base}/api/status`, { headers: { cookie: viewer } });
    await fetch(`${base}/api/status`, { headers: { cookie: approver } });
    const list = sessions.list();
    expect(list.map((s) => s.user).sort()).toEqual(['console', 'console:omar']);
    const target = list.find((s) => s.user === 'console');
    expect(target?.since).toMatch(/^\d{4}-\d\d-\d\dT/);

    const res = await fetch(`${base}/api/chat/events?conversation=c1`, {
      headers: { cookie: viewer },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const before = streamStops;
    await sessions.revoke(target?.id ?? '');
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(streamStops).toBe(before + 1);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: viewer } })).status).toBe(401);
    expect(sessions.list().map((s) => s.user)).toEqual(['console:omar']);

    // The sign-out is saved, so the agent still refuses it after a restart.
    const reloaded = new SessionRegistry({ path });
    await reloaded.load();
    const again = await start({ sessions: reloaded });
    expect((await fetch(`${again.base}/api/status`, { headers: { cookie: viewer } })).status).toBe(
      401,
    );
    expect(
      (await fetch(`${again.base}/api/status`, { headers: { cookie: approver } })).status,
    ).toBe(200);
  });

  it('streams events to a signed-in session and stops them on sign-out', async () => {
    const { base, login } = await start();
    expect((await fetch(`${base}/api/chat/events?conversation=c1`)).status).toBe(401);
    const cookie = sessionCookie(await login(TOKEN));
    expect(
      (await fetch(`${base}/api/chat/events?conversation=nope`, { headers: { cookie } })).status,
    ).toBe(404);

    const res = await fetch(`${base}/api/chat/events?conversation=c1`, {
      headers: { cookie, 'last-event-id': '41' },
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('world')) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('id: 42\ndata: {"hello":"world"}');

    const before = streamStops;
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(streamStops).toBe(before + 1);
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
