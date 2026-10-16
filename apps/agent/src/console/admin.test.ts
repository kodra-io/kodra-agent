import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { tempDir } from '../test-helpers.ts';
import { ADMIN_USER, AdminAccount, passwordProblem } from './admin.ts';
import { ACTION_HEADER, startConsoleServer } from './server.ts';

const TOKEN = 'console-token-for-admin-tests-91c3'; // gitleaks:allow
const NEW_PASSWORD = 'a-long-new-password-42';
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

async function start(dir?: string) {
  const home = dir ?? (await tempDir());
  const audit = new AuditLog(join(home, 'audit.jsonl'), new Redactor());
  const account = new AdminAccount({ path: join(home, 'console-users.json'), audit });
  await account.load();
  const staticDir = await tempDir();
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>console</title>');
  server = await startConsoleServer({
    port: 0,
    host: '127.0.0.1',
    accounts: [{ token: TOKEN, user: { name: 'console', canApprove: false } }],
    admin: { account, user: { name: ADMIN_USER, canApprove: true } },
    staticDir,
    routes: { status: () => ({ ok: true }) },
    actions: { say: () => ({ status: 200, body: { said: true } }) },
  });
  const address = server.address();
  const base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  const post = (route: string, body: unknown, cookie = '') =>
    fetch(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: '1', cookie },
      body: JSON.stringify(body),
    });
  const login = (username: string, password: string) => post('login', { username, password });
  const getJson = async (route: string, cookie: string) => {
    const res = await fetch(`${base}/api/${route}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { home, post, login, getJson };
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describe('console admin password', () => {
  it('signs in with admin/admin and allows nothing until the password changes', async () => {
    const { login, post, getJson } = await start();
    expect((await login('admin', 'wrong')).status).toBe(401);
    expect((await login('root', 'admin')).status).toBe(401);

    const first = await login('admin', 'admin');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ signedIn: true, mustChangePassword: true });
    const cookie = cookieOf(first);

    expect((await getJson('session', cookie)).body).toMatchObject({
      signedIn: true,
      user: ADMIN_USER,
      mustChangePassword: true,
      passwordAccount: true,
    });
    expect(await getJson('status', cookie)).toEqual({
      status: 403,
      body: { error: 'change the admin password first', mustChangePassword: true },
    });
    expect((await post('say', {}, cookie)).status).toBe(403);
  });

  it('changes the password: checks the current one and the rules, then ends old sessions', async () => {
    const { home, login, post, getJson } = await start();
    const cookie = cookieOf(await login('admin', 'admin'));

    const wrong = await post('password', { current: 'nope', next: NEW_PASSWORD }, cookie);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'wrong-current' });
    for (const next of ['short', 'admin', 'admin'.padEnd(300, 'x')]) {
      const weak = await post('password', { current: 'admin', next }, cookie);
      expect(await weak.json()).toMatchObject({ code: 'weak' });
    }

    const changed = await post('password', { current: 'admin', next: NEW_PASSWORD }, cookie);
    expect(changed.status).toBe(200);
    const fresh = cookieOf(changed);
    expect((await getJson('status', fresh)).status).toBe(200);
    // The old session was signed with the old key.
    expect((await getJson('status', cookie)).status).toBe(401);

    expect((await login('admin', 'admin')).status).toBe(401);
    const again = await login('admin', NEW_PASSWORD);
    expect(await again.json()).toEqual({ signedIn: true, mustChangePassword: false });

    // Only a salted hash is kept, owner-only, and the change is audited (never the password).
    const file = await readFile(join(home, 'console-users.json'), 'utf8');
    expect(file).not.toContain(NEW_PASSWORD);
    expect(Object.keys((JSON.parse(file) as { admin: object }).admin)).toEqual(['salt', 'hash']);
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'console-users.json'))).mode & 0o777).toBe(0o600);
    }
    const audit = await readFile(join(home, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('changed the console admin password');
    expect(audit).not.toContain(NEW_PASSWORD);
  });

  it('keeps the new password over a restart', async () => {
    const { home, login, post } = await start();
    const cookie = cookieOf(await login('admin', 'admin'));
    await post('password', { current: 'admin', next: NEW_PASSWORD }, cookie);

    const again = await start(home);
    expect((await again.login('admin', 'admin')).status).toBe(401);
    expect((await again.login('admin', NEW_PASSWORD)).status).toBe(200);
  });

  it('refuses a broken password file instead of falling back to admin/admin', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'console-users.json'), '{"admin":{}}');
    await expect(
      new AdminAccount({ path: join(home, 'console-users.json') }).load(),
    ).rejects.toThrow(/not a console password file/);
  });

  it('still signs in with a token, and a token account has no password to change', async () => {
    const { post } = await start();
    const res = await post('login', { token: TOKEN });
    expect(await res.json()).toEqual({ signedIn: true, mustChangePassword: false });
    const changed = await post('password', { current: 'admin', next: NEW_PASSWORD }, cookieOf(res));
    expect(changed.status).toBe(403);
  });

  it('limits wrong passwords like wrong tokens', async () => {
    const { login } = await start();
    for (let i = 0; i < 10; i++) expect((await login('admin', 'guess')).status).toBe(401);
    expect((await login('admin', 'admin')).status).toBe(429);
  });

  it('checks new passwords', () => {
    expect(passwordProblem('short', 'admin')).toMatch(/12 characters/);
    expect(passwordProblem('admin', 'x')).not.toBeNull();
    expect(passwordProblem(NEW_PASSWORD, NEW_PASSWORD)).not.toBeNull();
    expect(passwordProblem(NEW_PASSWORD, 'admin')).toBeNull();
  });
});
