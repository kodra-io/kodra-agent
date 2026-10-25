import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { tempDir, TEST_ADMIN_HASH, TEST_ADMIN_PASSWORD } from '../test-helpers.ts';
import { ADMIN_USER, AdminAccount, adminPasswordHash, passwordProblem } from './admin.ts';
import { ACTION_HEADER, startConsoleServer } from './server.ts';

const TOKEN = 'console-token-for-admin-tests-91c3'; // gitleaks:allow
const NEW_PASSWORD = 'a-long-new-password-42';
const RESET_PASSWORD = 'a-reset-password-77';
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

/** The console with the admin password `init` set (TEST_ADMIN_PASSWORD), or another hash. */
async function start(dir?: string, envHash: string = TEST_ADMIN_HASH) {
  const home = dir ?? (await tempDir());
  const audit = new AuditLog(join(home, 'audit.jsonl'), new Redactor());
  const account = new AdminAccount({ path: join(home, 'console-users.json'), envHash, audit });
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
  // L2: there is no default password. No code path accepts admin/admin.
  it('has no default: with no password set nothing signs in and the console does not start', async () => {
    const home = await tempDir();
    const account = new AdminAccount({ path: join(home, 'console-users.json') });
    await account.load();
    expect(account.isSet()).toBe(false);
    for (const guess of ['admin', '', 'password', TEST_ADMIN_PASSWORD]) {
      expect(await account.verify(guess)).toBe(false);
    }
    await expect(
      startConsoleServer({
        port: 0,
        host: '127.0.0.1',
        accounts: [],
        admin: { account, user: { name: ADMIN_USER, canApprove: true } },
        routes: {},
      }),
    ).rejects.toThrow(/no password/);
  });

  it('signs in with the password init set, never with admin/admin', async () => {
    const { login, getJson } = await start();
    for (const [user, password] of [
      ['admin', 'admin'],
      ['admin', ''],
      ['admin', 'wrong'],
      ['root', TEST_ADMIN_PASSWORD],
    ] as const) {
      expect((await login(user, password)).status).toBe(401);
    }
    const res = await login('admin', TEST_ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true });
    const cookie = cookieOf(res);
    expect((await getJson('session', cookie)).body).toMatchObject({
      signedIn: true,
      user: ADMIN_USER,
      passwordAccount: true,
    });
    expect((await getJson('status', cookie)).status).toBe(200);
  });

  it('changes the password: checks the current one and the rules, then ends old sessions', async () => {
    const { home, login, post, getJson } = await start();
    const cookie = cookieOf(await login('admin', TEST_ADMIN_PASSWORD));

    const wrong = await post('password', { current: 'nope', next: NEW_PASSWORD }, cookie);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'wrong-current' });
    for (const next of ['short', 'admin', TEST_ADMIN_PASSWORD, 'x'.repeat(300)]) {
      const weak = await post('password', { current: TEST_ADMIN_PASSWORD, next }, cookie);
      expect(await weak.json()).toMatchObject({ code: 'weak' });
    }

    const changed = await post(
      'password',
      { current: TEST_ADMIN_PASSWORD, next: NEW_PASSWORD },
      cookie,
    );
    expect(changed.status).toBe(200);
    const fresh = cookieOf(changed);
    expect((await getJson('status', fresh)).status).toBe(200);
    // The old session was signed with the old key.
    expect((await getJson('status', cookie)).status).toBe(401);

    expect((await login('admin', TEST_ADMIN_PASSWORD)).status).toBe(401);
    expect((await login('admin', NEW_PASSWORD)).status).toBe(200);

    // Only a salted hash is kept, owner-only, and the change is audited (never the password).
    const file = await readFile(join(home, 'console-users.json'), 'utf8');
    expect(file).not.toContain(NEW_PASSWORD);
    expect(Object.keys((JSON.parse(file) as { admin: object }).admin)).toEqual([
      'salt',
      'hash',
      'setAt',
    ]);
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'console-users.json'))).mode & 0o777).toBe(0o600);
    }
    const audit = await readFile(join(home, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('changed the console admin password');
    expect(audit).not.toContain(NEW_PASSWORD);
  });

  it('keeps a password changed in the console over a restart, until init sets a newer one', async () => {
    const { home, login, post } = await start();
    const cookie = cookieOf(await login('admin', TEST_ADMIN_PASSWORD));
    await post('password', { current: TEST_ADMIN_PASSWORD, next: NEW_PASSWORD }, cookie);

    // The same hash from init as before: the console's newer password wins.
    const again = await start(home);
    expect((await again.login('admin', TEST_ADMIN_PASSWORD)).status).toBe(401);
    expect((await again.login('admin', NEW_PASSWORD)).status).toBe(200);

    // `init --reset-console-password` writes a newer hash: that one wins.
    const later = await adminPasswordHash(RESET_PASSWORD, Date.now() + 1000);
    const reset = await start(home, later);
    expect((await reset.login('admin', NEW_PASSWORD)).status).toBe(401);
    expect((await reset.login('admin', RESET_PASSWORD)).status).toBe(200);
  });

  it('refuses a broken password file or hash instead of starting without one', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'console-users.json'), '{"admin":{}}');
    await expect(
      new AdminAccount({ path: join(home, 'console-users.json') }).load(),
    ).rejects.toThrow(/not a console password file/);
    for (const envHash of ['admin', 'scrypt1:x:y:z', `${TEST_ADMIN_HASH}:extra`]) {
      const account = new AdminAccount({
        path: join(await tempDir(), 'console-users.json'),
        envHash,
      });
      await expect(account.load()).rejects.toThrow(/not a console password hash/);
    }
  });

  it('still signs in with a token, and a token account has no password to change', async () => {
    const { post } = await start();
    const res = await post('login', { token: TOKEN });
    expect(await res.json()).toEqual({ signedIn: true });
    const changed = await post(
      'password',
      { current: TEST_ADMIN_PASSWORD, next: NEW_PASSWORD },
      cookieOf(res),
    );
    expect(changed.status).toBe(403);
  });

  it('limits wrong passwords like wrong tokens', async () => {
    const { login } = await start();
    for (let i = 0; i < 10; i++) expect((await login('admin', 'guess')).status).toBe(401);
    expect((await login('admin', TEST_ADMIN_PASSWORD)).status).toBe(429);
  });

  it('checks new passwords: admin and short ones are refused like any weak one', () => {
    expect(passwordProblem('admin', '')).toMatch(/12 characters/);
    expect(passwordProblem('', '')).toMatch(/12 characters/);
    expect(passwordProblem('short', 'x')).toMatch(/12 characters/);
    expect(passwordProblem(NEW_PASSWORD, NEW_PASSWORD)).not.toBeNull();
    expect(passwordProblem(NEW_PASSWORD, TEST_ADMIN_PASSWORD)).toBeNull();
  });

  it('is described nowhere as having a default password', async () => {
    const root = new URL('../../../../', import.meta.url);
    const files = [
      'apps/configurator/src/locales/en.json',
      'apps/console/src/locales/en.json',
      'docs/console.md',
      'docs/known-limitations.md',
      'README.md',
      'packages/templates/src/bundle.ts',
      'apps/agent/src/console/admin.ts',
      'apps/agent/src/console/server.ts',
      'apps/agent/src/commands/run.ts',
    ];
    for (const name of files) {
      const text = await readFile(new URL(name, root), 'utf8');
      expect(text, name).not.toMatch(
        /admin\/admin|`admin`\/`admin`|password `?admin`?[ .,)]|admin and admin|first time, use admin/i,
      );
      expect(text, name).not.toContain('DEFAULT_ADMIN_PASSWORD');
      expect(text, name).not.toContain('mustChange');
    }
  });

  it('makes a hash that holds no password and round-trips', async () => {
    const value = await adminPasswordHash(NEW_PASSWORD, 5);
    expect(value).toMatch(/^scrypt1:5:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(value).not.toContain(NEW_PASSWORD);
    const account = new AdminAccount({
      path: join(await tempDir(), 'console-users.json'),
      envHash: value,
    });
    await account.load();
    expect(await account.verify(NEW_PASSWORD)).toBe(true);
    expect(await account.verify('admin')).toBe(false);
  });
});
