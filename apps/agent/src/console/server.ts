import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writePrivateFile } from '../env-file.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConsoleUser } from './approvals.ts';

/**
 * The console's HTTP server: the static app, a token sign-in, a JSON API, write actions
 * (chat and approvals), and server-sent events. Security: a session cookie (HttpOnly,
 * SameSite=Strict) after a constant-time token check, sign-in and message rate limits, an
 * Origin check on every POST, a required custom header and JSON body on actions, and strict
 * headers on every response (CSP allows only this origin).
 */

/** Where the built console lives: apps/console/dist (also its path in the agent image). */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../../console/dist/', import.meta.url));

const SESSION_COOKIE = 'kodra_console';
const SESSION_HOURS = 12;
const MAX_FAILED_SIGN_INS_PER_MINUTE = 10;
/** Actions must send this header: a plain cross-site form cannot, so it is a CSRF check too. */
export const ACTION_HEADER = 'x-kodra-console';
const MAX_ACTION_BODY = 16 * 1024;
const HEARTBEAT_MS = 20_000;

export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONSOLE_CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export interface RouteRequest {
  query: URLSearchParams;
  user: ConsoleUser;
}

/** A read route: returns JSON-serializable data. */
export type ApiRoute = (req: RouteRequest) => unknown;

/** Returned by a read route to answer 403 with this message. */
export class Forbidden {
  readonly error: string;
  constructor(error: string) {
    this.error = error;
  }
}

/** A write route (POST with a JSON body). */
export type ActionRoute = (
  req: RouteRequest & { body: Record<string, unknown> },
) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };

/**
 * A server-sent events route. Gets a `send` for each event and returns the function that
 * stops it, or null when there is nothing to stream (404).
 */
export type StreamRoute = (
  req: RouteRequest & { lastEventId: number },
  send: (id: number | null, data: unknown) => void,
) => (() => void) | null;

/** A sign-in token and who it signs in. */
export interface ConsoleAccount {
  token: string;
  user: ConsoleUser;
}

export interface ConsoleServerOptions {
  port: number;
  /** 0.0.0.0 in a container (compose maps it to 127.0.0.1 on the host). */
  host?: string;
  /** The shared token (view and chat) and each console approver's own token. */
  accounts: readonly ConsoleAccount[];
  routes: Record<string, ApiRoute>;
  actions?: Record<string, ActionRoute>;
  streams?: Record<string, StreamRoute>;
  /** Shown to the app with the session, e.g. whether chat is on. */
  features?: Record<string, boolean>;
  /** Who is signed in, and sign-outs (shared with the People routes). */
  sessions?: SessionRegistry;
  staticDir?: string;
  now?: () => number;
}

interface Session {
  id: string;
  expires: number;
  user: ConsoleUser;
  streams: Set<() => void>;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Sessions are signed cookies, not server memory, so a restart (to apply settings) keeps
 * everyone signed in: `<payload>.<mac>`, the payload naming the session id, the user, and the
 * expiry, the mac keyed by a hash of that user's token. Rotating a token ends its sessions;
 * signing out ends one at once (a revoked list, kept until the session would expire anyway).
 */
interface SessionPayload {
  i: string;
  u: string;
  e: number;
  /** When it was signed in, for the list of sessions. */
  t: number;
}

function signSession(key: Buffer, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export interface SessionInfo {
  id: string;
  user: string;
  since: string;
  lastSeen: string;
}

/**
 * Who is signed in, as seen since the agent started (sessions are signed cookies, so the list
 * fills again as people use the console after a restart), and the sessions that were signed
 * out. Signed-out sessions are saved, when a path is given, so a restart does not bring them
 * back before they would expire anyway.
 */
export class SessionRegistry {
  private readonly active = new Map<string, { user: string; since: number; lastSeen: number }>();
  private readonly revoked = new Map<string, number>();
  private readonly streams = new Map<string, Set<() => void>>();
  private readonly path: string | undefined;
  private readonly now: () => number;

  constructor(opts: { path?: string; now?: () => number } = {}) {
    this.path = opts.path;
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (!this.path) return;
    const text = await readFile(this.path, 'utf8').catch(() => null);
    if (!text) return;
    try {
      for (const [id, expires] of Object.entries(JSON.parse(text) as Record<string, unknown>)) {
        if (typeof expires === 'number' && expires > this.now()) this.revoked.set(id, expires);
      }
    } catch {
      // A broken file only forgets sign-outs that expire within 12 hours anyway.
    }
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  seen(id: string, user: string, since: number): Set<() => void> {
    const entry = this.active.get(id);
    if (entry) entry.lastSeen = this.now();
    else this.active.set(id, { user, since, lastSeen: this.now() });
    let set = this.streams.get(id);
    if (!set) {
      set = new Set();
      this.streams.set(id, set);
    }
    return set;
  }

  list(): SessionInfo[] {
    return [...this.active]
      .map(([id, s]) => ({
        id,
        user: s.user,
        since: new Date(s.since).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
      }))
      .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  }

  /** Ends a session now: it is refused from here on, and its live streams stop. */
  async revoke(id: string, expires = this.now() + SESSION_HOURS * 3_600_000): Promise<void> {
    this.revoked.set(id, expires);
    for (const [other, until] of this.revoked) if (until < this.now()) this.revoked.delete(other);
    this.active.delete(id);
    for (const stop of this.streams.get(id) ?? []) stop();
    this.streams.delete(id);
    if (this.path) {
      await writePrivateFile(this.path, `${JSON.stringify(Object.fromEntries(this.revoked))}\n`);
    }
  }
}

export async function startConsoleServer(o: ConsoleServerOptions): Promise<Server> {
  const now = o.now ?? (() => Date.now());
  const accounts = o.accounts.map((a) => ({ digest: digest(a.token), user: a.user }));
  const registry = o.sessions ?? new SessionRegistry({ now });
  const failures = new Map<string, number[]>();
  const staticDir = resolve(o.staticDir ?? DEFAULT_STATIC_DIR);

  const sessionOf = (req: IncomingMessage): Session | null => {
    const value = cookie(req, SESSION_COOKIE);
    const [body, mac] = value?.split('.') ?? [];
    if (!body || !mac) return null;
    let payload: { i?: unknown; u?: unknown; e?: unknown; t?: unknown };
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload;
    } catch {
      return null;
    }
    const { i, u, e, t } = payload;
    if (
      typeof i !== 'string' ||
      typeof u !== 'string' ||
      typeof e !== 'number' ||
      typeof t !== 'number'
    ) {
      return null;
    }
    const account = accounts.find((a) => a.user.name === u);
    if (!account || e < now() || registry.isRevoked(i)) return null;
    const expected = Buffer.from(signSession(account.digest, { i, u, e, t }).split('.')[1] ?? '');
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { id: i, expires: e, user: account.user, streams: registry.seen(i, u, t) };
  };

  const endSession = async (session: Session) => {
    await registry.revoke(session.id, session.expires);
  };

  /** Checks every account in constant time, so timing says nothing about which matched. */
  const accountFor = (token: string): ConsoleUser | null => {
    const given = digest(token);
    let found: ConsoleUser | null = null;
    for (const a of accounts) if (timingSafeEqual(given, a.digest)) found = a.user;
    return found;
  };

  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://console.local');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      res.setHeader('cache-control', 'no-store');
      const name = path.slice('/api/'.length);
      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'cross-origin request refused' });
          return;
        }
        if (name === 'login') {
          const ip = req.socket.remoteAddress ?? 'unknown';
          const recent = (failures.get(ip) ?? []).filter((t) => t > now() - 60_000);
          if (recent.length >= MAX_FAILED_SIGN_INS_PER_MINUTE) {
            json(res, 429, { error: 'too many attempts, wait a minute' });
            return;
          }
          const body = await readBody(req, 8 * 1024);
          const user = accountFor(typeof body?.['token'] === 'string' ? body['token'] : '');
          if (!user) {
            failures.set(ip, [...recent, now()]);
            json(res, 401, { error: 'wrong token' });
            return;
          }
          failures.delete(ip);
          const account = accounts.find((a) => a.user === user);
          if (!account) throw new Error('account vanished');
          const value = signSession(account.digest, {
            i: randomBytes(18).toString('base64url'),
            u: user.name,
            e: now() + SESSION_HOURS * 3_600_000,
            t: now(),
          });
          res.setHeader(
            'set-cookie',
            `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(SESSION_HOURS * 3600)}`,
          );
          json(res, 200, { signedIn: true });
          return;
        }
        if (name === 'logout') {
          const session = sessionOf(req);
          if (session) await endSession(session);
          res.setHeader(
            'set-cookie',
            `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
          json(res, 200, { signedIn: false });
          return;
        }
        const action = o.actions?.[name];
        if (!action) {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (req.headers[ACTION_HEADER] !== '1') {
          json(res, 403, { error: `missing the ${ACTION_HEADER} header` });
          return;
        }
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
          json(res, 415, { error: 'send JSON' });
          return;
        }
        const session = sessionOf(req);
        if (!session) {
          json(res, 401, { error: 'sign in first' });
          return;
        }
        const body = await readBody(req, MAX_ACTION_BODY);
        if (!body) {
          json(res, 400, {
            error: `send a JSON object of at most ${String(MAX_ACTION_BODY / 1024)} KB`,
          });
          return;
        }
        const result = await action({ query: url.searchParams, user: session.user, body });
        json(res, result.status, result.body);
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' });
        return;
      }
      if (name === 'session') {
        const session = sessionOf(req);
        json(
          res,
          200,
          session
            ? {
                signedIn: true,
                user: session.user.name,
                canApprove: session.user.canApprove,
                features: o.features ?? {},
              }
            : { signedIn: false },
        );
        return;
      }
      const session = sessionOf(req);
      if (!session) {
        json(res, 401, { error: 'sign in first' });
        return;
      }
      const stream = o.streams?.[name];
      if (stream) {
        serveStream(req, res, session, url, stream);
        return;
      }
      const route = o.routes[name];
      if (!route) {
        json(res, 404, { error: 'not found' });
        return;
      }
      const result = await route({ query: url.searchParams, user: session.user });
      if (result instanceof Forbidden) json(res, 403, { error: result.error });
      else json(res, 200, result);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(staticDir, path, res);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '0.0.0.0', resolveListen);
  });
  return server;
}

function serveStream(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  url: URL,
  stream: StreamRoute,
): void {
  const header = req.headers['last-event-id'];
  const lastEventId = Number(typeof header === 'string' ? header : url.searchParams.get('after'));
  let open = false;
  const start = () => {
    if (open) return;
    open = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
  };
  const send = (id: number | null, data: unknown) => {
    start();
    res.write(`${id === null ? '' : `id: ${String(id)}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
  const stopRoute = stream(
    {
      query: url.searchParams,
      user: session.user,
      lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
    },
    send,
  );
  if (!stopRoute) {
    json(res, 404, { error: 'not found' });
    return;
  }
  start();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    stopRoute();
    session.streams.delete(stop);
    res.end();
  };
  session.streams.add(stop);
  req.on('close', stop);
}

/** The file for a path, or the app's index.html for its routes. Never outside staticDir. */
async function serveStatic(dir: string, path: string, res: ServerResponse): Promise<void> {
  const target = resolve(join(dir, normalize(decodeURIComponent(path))));
  const inside = target === dir || target.startsWith(dir + sep);
  const isFile = inside && (await stat(target).catch(() => null))?.isFile() === true;
  const file = isFile ? target : join(dir, 'index.html');
  const body = await readFile(file).catch(() => null);
  if (!body) {
    res
      .writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      .end(
        'The console is not built. In a source checkout: pnpm --filter @kodra-agent/console build',
      );
    return;
  }
  const hashed = /\/assets\//.test(file.split(sep).join('/'));
  res
    .writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    .end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** POSTs must come from this console's own page (SameSite cookies, plus this check). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
