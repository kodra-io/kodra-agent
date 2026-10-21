import { readFile, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
import { Server, utils, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyInputFor } from '../agent.ts';
import { AuditLog } from '../audit.ts';
import { fileBackend } from '../console/config-backend.ts';
import { SettingsStore } from '../console/settings.ts';
import { components } from '../config.ts';
import { ConnectorHost } from '../mcp/host.ts';
import { decide } from '../policy.ts';
import { Redactor } from '../redactor.ts';
import { resolveAll } from '../secrets.ts';
import { jsonLogger } from '../io.ts';
import { configYaml, fakeKubernetes, posixPath, tempDir } from '../test-helpers.ts';
import { checkDatabase, type DatabaseEntry } from './health.ts';
import { testKeyPair } from './test-keys.ts';
import { fingerprint } from './tunnel.ts';

/**
 * The Databases connector against real MariaDB and PostgreSQL servers (CI runs them as
 * services; locally, see docs/connectors/databases.md). Run with KODRA_DB_E2E=1 and each
 * server's port and test password in the environment.
 */
const env = process.env;
const enabled = env['KODRA_DB_E2E'] === '1';
const MARIADB_PORT = Number(env['KODRA_DB_E2E_MARIADB_PORT'] ?? '13306');
const POSTGRES_PORT = Number(env['KODRA_DB_E2E_POSTGRES_PORT'] ?? '15432');
const MARIADB_PASSWORD = env['KODRA_DB_E2E_MARIADB_PASSWORD'] ?? '';
const POSTGRES_PASSWORD = env['KODRA_DB_E2E_POSTGRES_PASSWORD'] ?? '';

const entry = (over: Partial<DatabaseEntry>): DatabaseEntry => ({
  name: 'orders',
  engine: 'mariadb',
  host: '127.0.0.1',
  port: MARIADB_PORT,
  database: undefined,
  user: 'kodra_monitor',
  password: MARIADB_PASSWORD,
  tls: 'off',
  tunnel: undefined,
  maxLagSeconds: 30,
  connectionsWarnPercent: 90,
  missing: undefined,
  ...over,
});

const deps = { timeoutMs: 5_000 };

describe.skipIf(!enabled)('databases, for real', () => {
  it('reads MariaDB: version, uptime, connections, and not read-only', async () => {
    const health = await checkDatabase(entry({}), deps);
    expect(health).toMatchObject({ name: 'orders', state: 'ok', via: 'direct', readOnly: false });
    expect(health.version).toMatch(/MariaDB/);
    expect(health.uptimeSeconds).toBeGreaterThan(0);
    expect(health.connections?.used).toBeGreaterThan(0);
    expect(health.connections?.max).toBeGreaterThan(health.connections?.used ?? 0);
    // Not a replica.
    expect(health.replicaLagSeconds).toBeNull();
  });

  it('reads PostgreSQL the same way', async () => {
    const health = await checkDatabase(
      entry({
        engine: 'postgres',
        port: POSTGRES_PORT,
        user: 'postgres',
        password: POSTGRES_PASSWORD,
      }),
      deps,
    );
    expect(health).toMatchObject({ state: 'ok', engine: 'postgres', readOnly: false });
    expect(health.version).toMatch(/^PostgreSQL \d+/);
    expect(health.connections?.used).toBeGreaterThan(0);
  });

  it('is down with a plain reason, never the password, when sign-in fails', async () => {
    for (const engine of ['mariadb', 'postgres'] as const) {
      const health = await checkDatabase(
        entry({
          engine,
          port: engine === 'postgres' ? POSTGRES_PORT : MARIADB_PORT,
          password: 'wrong-pw-c4n4ry',
        }),
        deps,
      );
      expect(health).toMatchObject({
        state: 'down',
        reasons: ['the user or password was refused'],
      });
      expect(JSON.stringify(health)).not.toContain('c4n4ry');
    }
  });

  it('is down when nothing listens, or encryption is asked of a server without it', async () => {
    expect((await checkDatabase(entry({ port: 1 }), deps)).reasons).toEqual([
      'the connection was refused (is the host and port right?)',
    ]);
    const tls = await checkDatabase(
      entry({
        engine: 'postgres',
        port: POSTGRES_PORT,
        user: 'postgres',
        password: POSTGRES_PASSWORD,
        tls: 'verify',
      }),
      deps,
    );
    expect(tls.state).toBe('down');
    expect(tls.reasons[0]).toMatch(/encryption|certificate/);
  });

  describe('through an SSH tunnel', () => {
    const hostKeys = testKeyPair();
    const userKeys = testKeyPair();
    let bastion: Server;
    let port = 0;
    beforeAll(async () => {
      bastion = new Server({ hostKeys: [hostKeys.private] }, (client: Connection) => {
        client.on('authentication', (ctx) => {
          if (ctx.method === 'publickey') ctx.accept();
          else ctx.reject();
        });
        client.on('ready', () => {
          client.on('tcpip', (accept, _reject, info) => {
            const channel = accept();
            const socket = connect(info.destPort, info.destIP);
            channel.pipe(socket).pipe(channel);
          });
        });
        client.on('error', () => undefined);
      });
      await new Promise<void>((resolve) => bastion.listen(0, '127.0.0.1', resolve));
      port = (bastion.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) =>
        bastion.close(() => {
          resolve();
        }),
      );
    });
    const hostKey = () => {
      const parsed = utils.parseKey(hostKeys.public);
      if (parsed instanceof Error) throw parsed;
      return fingerprint(parsed.getPublicSSH());
    };

    it('reads both engines through the bastion', async () => {
      const tunnel = () => ({
        host: '127.0.0.1',
        port,
        user: 'tunnel',
        hostKey: hostKey(),
        privateKey: userKeys.private,
      });
      const maria = await checkDatabase(entry({ tunnel: tunnel() }), deps);
      expect(maria).toMatchObject({ state: 'ok', via: 'tunnel' });
      const postgres = await checkDatabase(
        entry({
          engine: 'postgres',
          port: POSTGRES_PORT,
          user: 'postgres',
          password: POSTGRES_PASSWORD,
          tunnel: tunnel(),
        }),
        deps,
      );
      expect(postgres).toMatchObject({ state: 'ok', via: 'tunnel' });
    });

    it('is down, and never connects, when the bastion host key changed', async () => {
      const health = await checkDatabase(
        entry({
          tunnel: {
            host: '127.0.0.1',
            port,
            user: 'tunnel',
            hostKey: `SHA256:${'A'.repeat(43)}`,
            privateKey: userKeys.private,
          },
        }),
        deps,
      );
      expect(health).toMatchObject({
        state: 'down',
        reasons: ['the tunnel host key does not match the pinned fingerprint: refused'],
      });
    });
  });

  it('runs as a connector: two read tools, guarded to the listed databases', async () => {
    const yaml = configYaml({
      auditPath: '/tmp/kodra-db-e2e/audit.jsonl',
      connectors: `    databases:
      enabled: true
      access: read-only
      config:
        databases:
          - name: orders
            engine: mariadb
            host: 127.0.0.1
            port: ${String(MARIADB_PORT)}
            user: kodra_monitor
            password: \${env:KODRA_DB_ORDERS_PASSWORD}
            tls: 'off'`,
    });
    const parsed = parseAgentConfig(yaml);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const comp = components(parsed.config).find((c) => c.id === 'databases');
    if (!comp) throw new Error('missing');
    const redactor = new Redactor();
    const resolved = await resolveAll(comp.secrets, {
      env: { KODRA_DB_ORDERS_PASSWORD: MARIADB_PASSWORD },
      redactor,
    });
    expect(Object.keys(resolved.values)).toEqual(['orders.password']);
    const host = await ConnectorHost.start(
      [{ component: comp, access: 'read-only', secrets: resolved.values }],
      { redactor, log: jsonLogger(() => undefined, redactor) },
    );
    try {
      expect(host.failures()).toEqual([]);
      expect(
        host
          .tools()
          .map((t) => t.name)
          .sort(),
      ).toEqual(['databases__database_health', 'databases__list_databases']);
      const tool = host.get('databases__database_health');
      if (!tool) throw new Error('missing tool');
      // A database that is not listed is refused before any call.
      expect(decide(policyInputFor(tool, { database: 'payments' }, 'deny', null))).toMatchObject({
        kind: 'block',
      });
      expect(decide(policyInputFor(tool, { database: 'orders' }, 'deny', null)).kind).toBe('allow');
      const result = await host.call(tool.name, { database: 'orders' });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ name: 'orders', state: 'ok' });
      const list = await host.call('databases__list_databases', {});
      expect(list.text).not.toContain(MARIADB_PASSWORD);
    } finally {
      await host.close();
    }
  });

  it('saves a password from the console only after it connects', async () => {
    const dir = await tempDir();
    const configPath = join(dir, 'kodra-agent.yaml');
    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(
      configPath,
      configYaml({
        auditPath: posixPath(auditPath),
        approvers: ['console:omar'],
        connectors: `    databases:
      enabled: true
      access: read-only
      config:
        databases:
          - name: orders
            engine: mariadb
            host: 127.0.0.1
            port: ${String(MARIADB_PORT)}
            user: kodra_monitor
            password: \${env:KODRA_DB_ORDERS_PASSWORD}
            tls: 'off'`,
      }),
    );
    const redactor = new Redactor();
    const store = new SettingsStore({
      backend: fileBackend(configPath),
      audit: new AuditLog(auditPath, redactor),
      redactor,
      env: {},
      fetch: globalThis.fetch,
      kubernetes: fakeKubernetes(),
      probeTimeoutMs: 5_000,
    });
    expect(
      await store.setSecret('databases', 'orders.password', 'wrong-pw-1', 'console:omar'),
    ).toMatchObject({
      status: 'fail',
    });
    const ok = await store.setSecret(
      'databases',
      'orders.password',
      MARIADB_PASSWORD,
      'console:omar',
    );
    expect(ok).toMatchObject({ status: 'pass', message: 'orders: ok' });
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('KODRA_DB_ORDERS_PASSWORD=');
    expect(await readFile(auditPath, 'utf8')).not.toContain(MARIADB_PASSWORD);
  });
});
