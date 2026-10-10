import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
  staticDir?: string;
  now?: () => number;
}

interface Session {
  expires: number;
  user: ConsoleUser;
  streams: Set<() => void>;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export async function startConsoleServer(o: ConsoleServerOptions): Promise<Server> {
  const now = o.now ?? (() => Date.now());
  const accounts = o.accounts.map((a) => ({ digest: digest(a.token), user: a.user }));
  const sessions = new Map<string, Session>();
  const failures = new Map<string, number[]>();
  const staticDir = resolve(o.staticDir ?? DEFAULT_STATIC_DIR);

  const sessionOf = (req: IncomingMessage): Session | null => {
    const id = cookie(req, SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (session.expires < now()) {
      endSession(id);
      return null;
    }
    return session;
  };

  const endSession = (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    for (const stop of session?.streams ?? []) stop();
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
          const id = randomBytes(32).toString('base64url');
          sessions.set(id, {
            expires: now() + SESSION_HOURS * 3_600_000,
            user,
            streams: new Set(),
          });
          res.setHeader(
            'set-cookie',
            `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(SESSION_HOURS * 3600)}`,
          );
          json(res, 200, { signedIn: true });
          return;
        }
        if (name === 'logout') {
          const id = cookie(req, SESSION_COOKIE);
          if (id) endSession(id);
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
      json(res, 200, await route({ query: url.searchParams, user: session.user }));
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
