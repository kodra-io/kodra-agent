import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The console's HTTP server (M8a): the static app, a token sign-in, and a read-only JSON API.
 * It never writes anything the agent acts on. Security: a session cookie (HttpOnly,
 * SameSite=Strict) after a constant-time token check, sign-in rate limiting, an Origin check
 * on POST, and strict headers on every response (CSP allows only this origin).
 */

/** Where the built console lives: apps/console/dist (also its path in the agent image). */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../../console/dist/', import.meta.url));

const SESSION_COOKIE = 'kodra_console';
const SESSION_HOURS = 12;
const MAX_FAILED_SIGN_INS_PER_MINUTE = 10;

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

/** A read-only API route: gets the query string, returns JSON-serializable data. */
export type ApiRoute = (query: URLSearchParams) => unknown;

export interface ConsoleServerOptions {
  port: number;
  /** 0.0.0.0 in a container (compose maps it to 127.0.0.1 on the host). */
  host?: string;
  /** The sign-in token (KODRA_CONSOLE_TOKEN). */
  token: string;
  routes: Record<string, ApiRoute>;
  staticDir?: string;
  now?: () => number;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export async function startConsoleServer(o: ConsoleServerOptions): Promise<Server> {
  const now = o.now ?? (() => Date.now());
  const expected = digest(o.token);
  const sessions = new Map<string, number>();
  const failures = new Map<string, number[]>();
  const staticDir = resolve(o.staticDir ?? DEFAULT_STATIC_DIR);

  const signedIn = (req: IncomingMessage): boolean => {
    const id = cookie(req, SESSION_COOKIE);
    const expires = id ? sessions.get(id) : undefined;
    if (!id || expires === undefined) return false;
    if (expires < now()) {
      sessions.delete(id);
      return false;
    }
    return true;
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
      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'cross-origin request refused' });
          return;
        }
        if (path === '/api/login') {
          const ip = req.socket.remoteAddress ?? 'unknown';
          const recent = (failures.get(ip) ?? []).filter((t) => t > now() - 60_000);
          if (recent.length >= MAX_FAILED_SIGN_INS_PER_MINUTE) {
            json(res, 429, { error: 'too many attempts, wait a minute' });
            return;
          }
          const body = await readBody(req);
          const given = typeof body?.['token'] === 'string' ? body['token'] : '';
          if (!timingSafeEqual(digest(given), expected)) {
            failures.set(ip, [...recent, now()]);
            json(res, 401, { error: 'wrong token' });
            return;
          }
          failures.delete(ip);
          const id = randomBytes(32).toString('base64url');
          sessions.set(id, now() + SESSION_HOURS * 3_600_000);
          res.setHeader(
            'set-cookie',
            `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(SESSION_HOURS * 3600)}`,
          );
          json(res, 200, { signedIn: true });
          return;
        }
        if (path === '/api/logout') {
          const id = cookie(req, SESSION_COOKIE);
          if (id) sessions.delete(id);
          res.setHeader(
            'set-cookie',
            `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
          json(res, 200, { signedIn: false });
          return;
        }
        json(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'read-only' });
        return;
      }
      if (path === '/api/session') {
        json(res, 200, { signedIn: signedIn(req) });
        return;
      }
      if (!signedIn(req)) {
        json(res, 401, { error: 'sign in first' });
        return;
      }
      const route = o.routes[path.slice('/api/'.length)];
      if (!route) {
        json(res, 404, { error: 'not found' });
        return;
      }
      json(res, 200, await route(url.searchParams));
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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
