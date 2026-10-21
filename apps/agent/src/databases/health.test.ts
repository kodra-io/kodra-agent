import { describe, expect, it } from 'vitest';
import { checkDatabase, failureReason, judge } from './health.ts';
import { databaseEntries, describeEntry } from './server.ts';
import { TunnelError } from './tunnel.ts';

const limits = { maxLagSeconds: 30, connectionsWarnPercent: 90 };
const reading = {
  version: '11.4.3-MariaDB',
  uptimeSeconds: 100,
  connections: { used: 10, max: 100 },
  readOnly: false,
  replica: null,
};

describe('database health: the state and why', () => {
  it('is ok below the limits', () => {
    expect(judge(limits, reading)).toEqual({ state: 'ok', reasons: [] });
  });

  it('is degraded when connections reach the warning level', () => {
    expect(judge(limits, { ...reading, connections: { used: 90, max: 100 } })).toEqual({
      state: 'degraded',
      reasons: ['90 of 100 connections in use'],
    });
  });

  it('is degraded when a replica lags or stopped, and fine when it keeps up', () => {
    expect(
      judge(limits, { ...reading, replica: { lagSeconds: 45, running: true } }).reasons,
    ).toEqual(['the replica is 45s behind']);
    expect(
      judge(limits, { ...reading, replica: { lagSeconds: null, running: false } }).reasons,
    ).toEqual(['replication is not running']);
    expect(judge(limits, { ...reading, replica: { lagSeconds: 2, running: true } }).state).toBe(
      'ok',
    );
  });
});

describe('database health: failures in plain words', () => {
  it('maps driver errors to reasons, never their messages', () => {
    const reason = (code: string, message = 'driver says s3cr3t') =>
      failureReason(Object.assign(new Error(message), { code }), 10_000);
    expect(reason('ECONNREFUSED')).toBe('the connection was refused (is the host and port right?)');
    expect(reason('ENOTFOUND')).toBe('the host name was not found');
    expect(reason('ER_ACCESS_DENIED_ERROR')).toBe('the user or password was refused');
    expect(reason('28P01')).toBe('the user or password was refused');
    expect(reason('3D000')).toBe('that database does not exist');
    expect(reason('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toMatch(/certificate could not be verified/);
    expect(reason('ETIMEDOUT')).toBe('no answer within 10s');
    expect(reason('SOMETHING_ELSE')).toBe('could not connect');
    expect(failureReason(new TunnelError('the tunnel host refused the key for this user'), 1)).toBe(
      'the tunnel host refused the key for this user',
    );
  });

  it('says a missing secret is missing, without connecting', async () => {
    const [entry] = databaseEntries(
      {
        databases: [
          {
            name: 'orders',
            engine: 'postgres',
            host: 'db.internal',
            user: 'monitor',
            password: '${env:KODRA_DB_ORDERS_PASSWORD}',
          },
        ],
      },
      {},
    );
    if (!entry) throw new Error('missing');
    const health = await checkDatabase(entry, { timeoutMs: 1_000 });
    expect(health).toMatchObject({
      state: 'down',
      reasons: ['the password (KODRA_DB_ORDERS_PASSWORD) is not set'],
    });
  });
});

describe('database entries', () => {
  it('reads each entry with its own secrets and the engine defaults', () => {
    const entries = databaseEntries(
      {
        databases: [
          { name: 'orders', engine: 'mariadb', host: 'db1', user: 'm' },
          {
            name: 'billing',
            engine: 'postgres',
            host: 'billing.rds.amazonaws.com',
            port: 6432,
            database: 'billing',
            user: 'm',
            password: '${env:KODRA_DB_BILLING_PASSWORD}',
            tls: 'require',
            tunnelHost: 'bastion.example.com',
            tunnelUser: 'tunnel',
            tunnelHostKey: `SHA256:${'a'.repeat(43)}`,
            tunnelKey: '${env:KODRA_DB_BILLING_TUNNEL_KEY}',
          },
          // Not complete: left out rather than guessed.
          { name: 'broken', engine: 'oracle', host: 'x', user: 'm' },
        ],
      },
      { 'billing.password': 'pw', 'billing.tunnelKey': 'KEY' },
    );
    expect(entries.map((e) => [e.name, e.port, e.tls, e.password, e.tunnel?.port])).toEqual([
      ['orders', 3306, 'verify', undefined, undefined],
      ['billing', 6432, 'require', 'pw', 22],
    ]);
    expect(entries[1]?.tunnel?.privateKey).toBe('KEY');
    // What the model sees: where it is and how it connects, no secret.
    expect(describeEntry(entries[1] as (typeof entries)[number])).toEqual({
      name: 'billing',
      engine: 'postgres',
      host: 'billing.rds.amazonaws.com',
      port: 6432,
      database: 'billing',
      tls: 'require',
      via: 'ssh tunnel through bastion.example.com',
    });
  });
});
