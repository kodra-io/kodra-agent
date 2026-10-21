import type { Duplex } from 'node:stream';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { openTunnel, TunnelError, type Tunnel } from './tunnel.ts';

/**
 * A database's health, read with fixed queries only: no query text ever comes from the model,
 * the config, or a person. Every check after the connection is optional, because a monitoring
 * user may not see everything (replication needs REPLICATION CLIENT on MySQL).
 */

export type Engine = 'mariadb' | 'mysql' | 'postgres';
export type TlsMode = 'verify' | 'require' | 'off';

export interface DatabaseEntry {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string | undefined;
  user: string;
  password: string | undefined;
  tls: TlsMode;
  tunnel:
    | { host: string; port: number; user: string; hostKey: string; privateKey: string | undefined }
    | undefined;
  maxLagSeconds: number;
  connectionsWarnPercent: number;
  /** A secret the config names but that is not set: the check says so instead of connecting. */
  missing: string | undefined;
}

export type HealthState = 'ok' | 'degraded' | 'down';

export interface DatabaseHealth {
  name: string;
  engine: Engine;
  via: 'direct' | 'tunnel';
  state: HealthState;
  /** Why it is not ok, in plain words. */
  reasons: string[];
  version: string | null;
  uptimeSeconds: number | null;
  connections: { used: number; max: number } | null;
  readOnly: boolean | null;
  /** Seconds behind its source, for a replica; null for a primary or when it cannot be read. */
  replicaLagSeconds: number | null;
  latencyMs: number | null;
  checkedAt: string;
}

export const DEFAULT_PORT: Record<Engine, number> = { mariadb: 3306, mysql: 3306, postgres: 5432 };

/** What the drivers give back, before the state is decided. */
interface Reading {
  version: string | null;
  uptimeSeconds: number | null;
  connections: { used: number; max: number } | null;
  readOnly: boolean | null;
  replica: { lagSeconds: number | null; running: boolean } | null;
}

export interface CheckDeps {
  timeoutMs: number;
  now?: () => Date;
  /** Tests swap how a tunnel opens. */
  openTunnel?: typeof openTunnel;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Plain words for a connection failure. Driver messages are never passed on. */
export function failureReason(error: unknown, timeoutMs: number): string {
  if (error instanceof TunnelError) return error.message;
  const e = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (code === 'ECONNREFUSED') return 'the connection was refused (is the host and port right?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name was not found';
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) {
    return `no answer within ${String(timeoutMs / 1000)}s`;
  }
  if (
    code === 'ER_ACCESS_DENIED_ERROR' ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    code === '28P01' ||
    code === '28000'
  ) {
    return 'the user or password was refused';
  }
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000') return 'that database does not exist';
  if (
    /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS_CERT)/.test(code) ||
    /certificate/i.test(message)
  ) {
    return 'the server certificate could not be verified (add its CA under spec.network, or set tls to require)';
  }
  if (/does not support SSL|SSL off|server does not support/i.test(message)) {
    return 'the server does not offer encryption (set tls to off only on a private network)';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'the connection was closed by the server';
  return 'could not connect';
}

function tlsFor(
  entry: DatabaseEntry,
): { rejectUnauthorized: boolean; servername?: string } | undefined {
  if (entry.tls === 'off') return undefined;
  // Through a tunnel the certificate is still checked against the database's own name.
  return entry.tls === 'verify'
    ? { rejectUnauthorized: true, servername: entry.host }
    : { rejectUnauthorized: false };
}

async function readMysql(entry: DatabaseEntry, stream: Duplex | undefined, timeoutMs: number) {
  const ssl = tlsFor(entry);
  const conn = await mysql.createConnection({
    host: entry.host,
    port: entry.port,
    user: entry.user,
    ...(entry.password !== undefined ? { password: entry.password } : {}),
    ...(entry.database !== undefined ? { database: entry.database } : {}),
    ...(ssl ? { ssl } : {}),
    ...(stream ? { stream } : {}),
    connectTimeout: timeoutMs,
    // Fixed statements only, one at a time.
    multipleStatements: false,
  });
  try {
    const q = async (sql: string): Promise<Record<string, unknown>[]> => {
      const [rows] = await conn.query({ sql, timeout: timeoutMs });
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    };
    const reading: Reading = {
      version: null,
      uptimeSeconds: null,
      connections: null,
      readOnly: null,
      replica: null,
    };
    const [base] = await q('SELECT VERSION() AS v, @@read_only AS ro, @@max_connections AS mx');
    reading.version = typeof base?.['v'] === 'string' ? base['v'] : null;
    reading.readOnly = base?.['ro'] === undefined ? null : num(base['ro']) === 1;
    const status = await q(
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')",
    ).catch(() => []);
    const stat = (name: string) =>
      num(status.find((r) => r['Variable_name'] === name)?.['Value'] ?? null);
    reading.uptimeSeconds = stat('Uptime');
    const used = stat('Threads_connected');
    const max = num(base?.['mx']);
    if (used !== null && max !== null && max > 0) reading.connections = { used, max };
    // MySQL 8.0.22+ and MariaDB 10.5.1+ say REPLICA; older ones only SLAVE.
    const replicas = await q('SHOW REPLICA STATUS').catch(() =>
      q('SHOW SLAVE STATUS').catch(() => null),
    );
    const row = replicas?.[0];
    if (row) {
      const lag = num(row['Seconds_Behind_Source'] ?? row['Seconds_Behind_Master'] ?? null);
      const yes = (a: string, b: string) => (row[a] ?? row[b]) === 'Yes';
      reading.replica = {
        lagSeconds: lag,
        running:
          yes('Replica_IO_Running', 'Slave_IO_Running') &&
          yes('Replica_SQL_Running', 'Slave_SQL_Running'),
      };
    }
    return reading;
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function readPostgres(entry: DatabaseEntry, stream: Duplex | undefined, timeoutMs: number) {
  const ssl = tlsFor(entry);
  const client = new pg.Client({
    host: entry.host,
    port: entry.port,
    user: entry.user,
    ...(entry.password !== undefined ? { password: entry.password } : {}),
    database: entry.database ?? 'postgres',
    ssl: ssl ?? false,
    ...(stream ? { stream: () => stream } : {}),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'kodra-agent',
  });
  // A dropped connection after the check must not crash the agent.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const q = async (sql: string): Promise<Record<string, unknown>[]> =>
      (await client.query(sql)).rows as Record<string, unknown>[];
    const reading: Reading = {
      version: null,
      uptimeSeconds: null,
      connections: null,
      readOnly: null,
      replica: null,
    };
    const [base] = await q(
      "SELECT current_setting('server_version') AS v, pg_is_in_recovery() AS replica, " +
        "current_setting('max_connections')::int AS mx, " +
        "current_setting('default_transaction_read_only') AS ro, " +
        'extract(epoch from now() - pg_postmaster_start_time())::bigint AS up',
    );
    reading.version = typeof base?.['v'] === 'string' ? `PostgreSQL ${base['v']}` : null;
    const replica = base?.['replica'] === true;
    reading.readOnly = replica || base?.['ro'] === 'on';
    reading.uptimeSeconds = num(base?.['up']);
    const [count] = await q('SELECT count(*)::int AS n FROM pg_stat_activity').catch(() => []);
    const used = num(count?.['n']);
    const max = num(base?.['mx']);
    if (used !== null && max !== null && max > 0) reading.connections = { used, max };
    if (replica) {
      // Caught up means no lag, even when the source has had nothing to send for a while.
      const [lag] = await q(
        'SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0 ' +
          'ELSE extract(epoch from now() - pg_last_xact_replay_timestamp()) END AS lag, ' +
          "(SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming')::int AS streaming",
      ).catch(() => []);
      reading.replica = { lagSeconds: num(lag?.['lag']), running: num(lag?.['streaming']) !== 0 };
    }
    return reading;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The state a reading puts a database in, and why. */
export function judge(
  entry: Pick<DatabaseEntry, 'maxLagSeconds' | 'connectionsWarnPercent'>,
  reading: Reading,
): { state: HealthState; reasons: string[] } {
  const reasons: string[] = [];
  const c = reading.connections;
  if (c && (c.used / c.max) * 100 >= entry.connectionsWarnPercent) {
    reasons.push(`${String(c.used)} of ${String(c.max)} connections in use`);
  }
  const r = reading.replica;
  if (r && !r.running) reasons.push('replication is not running');
  else if (
    r?.lagSeconds !== null &&
    r?.lagSeconds !== undefined &&
    r.lagSeconds > entry.maxLagSeconds
  ) {
    reasons.push(`the replica is ${String(Math.round(r.lagSeconds))}s behind`);
  }
  return { state: reasons.length > 0 ? 'degraded' : 'ok', reasons };
}

/** Connects (through the tunnel, if any), reads, and closes. Never throws. */
export async function checkDatabase(
  entry: DatabaseEntry,
  deps: CheckDeps,
): Promise<DatabaseHealth> {
  const now = deps.now ?? (() => new Date());
  const base = {
    name: entry.name,
    engine: entry.engine,
    via: entry.tunnel ? ('tunnel' as const) : ('direct' as const),
    checkedAt: now().toISOString(),
  };
  const down = (reason: string): DatabaseHealth => ({
    ...base,
    state: 'down',
    reasons: [reason],
    version: null,
    uptimeSeconds: null,
    connections: null,
    readOnly: null,
    replicaLagSeconds: null,
    latencyMs: null,
  });
  if (entry.missing !== undefined) return down(`${entry.missing} is not set`);
  const started = Date.now();
  let tunnel: Tunnel | undefined;
  try {
    if (entry.tunnel) {
      if (entry.tunnel.privateKey === undefined) return down('the tunnel private key is not set');
      tunnel = await (deps.openTunnel ?? openTunnel)({
        host: entry.tunnel.host,
        port: entry.tunnel.port,
        user: entry.tunnel.user,
        hostKey: entry.tunnel.hostKey,
        privateKey: entry.tunnel.privateKey,
        target: { host: entry.host, port: entry.port },
        timeoutMs: deps.timeoutMs,
      });
    }
    const read = entry.engine === 'postgres' ? readPostgres : readMysql;
    const reading = await read(entry, tunnel?.stream, deps.timeoutMs);
    const { state, reasons } = judge(entry, reading);
    return {
      ...base,
      state,
      reasons,
      version: reading.version,
      uptimeSeconds: reading.uptimeSeconds,
      connections: reading.connections,
      readOnly: reading.readOnly,
      replicaLagSeconds: reading.replica?.lagSeconds ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return down(failureReason(error, deps.timeoutMs));
  } finally {
    tunnel?.close();
  }
}
