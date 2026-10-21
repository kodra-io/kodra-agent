import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { entriesOf, parseSecretRef } from '@kodra-agent/schema';
import { z } from 'zod';
import {
  checkDatabase,
  DEFAULT_PORT,
  type CheckDeps,
  type DatabaseEntry,
  type Engine,
} from './health.ts';

/**
 * The Databases connector's server, run inside the agent (a `builtin` runtime). Two read
 * tools, both with fixed queries: list what is configured, and check one database by name.
 */

export const DATABASE_TIMEOUT_MS = 10_000;

const ENGINES: readonly Engine[] = ['mariadb', 'mysql', 'postgres'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? v : fallback;

/** Where a missing secret was meant to come from, without its value (there is none). */
function whereFrom(ref: unknown): string {
  const parsed = typeof ref === 'string' ? parseSecretRef(ref) : null;
  if (parsed?.ok)
    return parsed.ref.scheme === 'env' ? parsed.ref.name : `the file ${parsed.ref.path}`;
  return 'a secret';
}

/**
 * The configured databases with their secrets. Secrets are keyed `<name>.<field>`, as the
 * config's components name them (see config.ts).
 */
export function databaseEntries(
  settings: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): DatabaseEntry[] {
  return entriesOf(settings['databases']).flatMap((raw): DatabaseEntry[] => {
    const name = str(raw['name']);
    const engine = ENGINES.find((e) => e === raw['engine']);
    const host = str(raw['host']);
    const user = str(raw['user']);
    if (!name || !engine || !host || !user) return [];
    const secret = (field: string) => secrets[`${name}.${field}`];
    let missing: string | undefined;
    if (raw['password'] !== undefined && secret('password') === undefined) {
      missing = `the password (${whereFrom(raw['password'])})`;
    }
    const tunnelHost = str(raw['tunnelHost']);
    let tunnel: DatabaseEntry['tunnel'];
    if (tunnelHost) {
      const tunnelUser = str(raw['tunnelUser']);
      const hostKey = str(raw['tunnelHostKey']);
      if (!tunnelUser || !hostKey) return [];
      tunnel = {
        host: tunnelHost,
        port: int(raw['tunnelPort'], 22),
        user: tunnelUser,
        hostKey,
        privateKey: secret('tunnelKey'),
      };
      if (raw['tunnelKey'] !== undefined && secret('tunnelKey') === undefined) {
        missing ??= `the tunnel key (${whereFrom(raw['tunnelKey'])})`;
      }
    }
    const tls = raw['tls'];
    return [
      {
        name,
        engine,
        host,
        port: int(raw['port'], DEFAULT_PORT[engine]),
        database: str(raw['database']),
        user,
        password: secret('password'),
        tls: tls === 'require' || tls === 'off' ? tls : 'verify',
        tunnel,
        maxLagSeconds: int(raw['maxLagSeconds'], 30),
        connectionsWarnPercent: int(raw['connectionsWarnPercent'], 90),
        missing,
      },
    ];
  });
}

/** What the model and the console may see about a database: never a secret. */
export function describeEntry(entry: DatabaseEntry) {
  return {
    name: entry.name,
    engine: entry.engine,
    host: entry.host,
    port: entry.port,
    ...(entry.database ? { database: entry.database } : {}),
    tls: entry.tls,
    via: entry.tunnel ? `ssh tunnel through ${entry.tunnel.host}` : 'direct',
  };
}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export function databasesServer(
  entries: readonly DatabaseEntry[],
  deps: Partial<CheckDeps> = {},
): McpServer {
  const server = new McpServer({ name: 'kodra-databases', version: '1.0.0' });
  const check: CheckDeps = { timeoutMs: DATABASE_TIMEOUT_MS, ...deps };
  server.registerTool(
    'list_databases',
    {
      description:
        'List the databases this agent watches: name, engine, host, port, and how it connects. No connection is made.',
      inputSchema: {},
    },
    () => json(entries.map(describeEntry)),
  );
  server.registerTool(
    'database_health',
    {
      description:
        "Check one database by name: whether it answers, its version, uptime, connections in use of the maximum, read-only, and a replica's lag, with a state (ok, degraded, down) and why. Runs fixed status queries only; it cannot run other SQL.",
      inputSchema: {
        database: z.string().min(1).describe('The database name from list_databases'),
      },
    },
    async ({ database }) => {
      const entry = entries.find((e) => e.name === database);
      if (!entry) return { ...json({ error: `no database named ${database}` }), isError: true };
      return json(await checkDatabase(entry, check));
    },
  );
  return server;
}
