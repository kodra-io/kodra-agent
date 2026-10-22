import { parseAgentConfig } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { generateBundle } from './bundle.ts';
import { configYaml, validateDraft } from './config.ts';
import { decodeDraft, encodeDraft, type AgentDraft, type EntryDraft } from './draft.ts';
import { composeDraft, withConnector } from './test-drafts.ts';

/** The compose example with the Databases connector and the given databases. */
function withDatabases(...databases: EntryDraft[]): AgentDraft {
  return withConnector(composeDraft(), 'databases', { entries: { databases } });
}

const orders: EntryDraft = {
  name: 'orders',
  engine: 'mariadb',
  host: 'orders.internal',
  user: 'kodra_monitor',
};
const tunnelled: EntryDraft = {
  name: 'billing-replica',
  engine: 'postgres',
  host: '10.0.3.12',
  port: '5433',
  user: 'kodra_monitor',
  tls: 'require',
  tunnelHost: 'bastion.example.com',
  tunnelUser: 'kodra',
  tunnelHostKey: `SHA256:${'A'.repeat(43)}`,
};

const file = (draft: AgentDraft, path: string) =>
  generateBundle(draft).files.find((f) => f.path === path)?.content ?? '';

const codes = (issues: ReturnType<typeof validateDraft>) =>
  issues.map((i) => `${i.field}:${i.code}`);

describe('databases in the draft', () => {
  it('writes each database with references to its own variables, and passes the schema', () => {
    const draft = withDatabases(orders, tunnelled);
    expect(validateDraft(draft)).toEqual([]);
    const yaml = configYaml(draft);
    expect(parseAgentConfig(yaml).ok).toBe(true);
    const config = parse(yaml) as {
      spec: { connectors: { databases: { config: { databases: unknown[] } } } };
    };
    expect(config.spec.connectors.databases.config.databases).toEqual([
      {
        name: 'orders',
        engine: 'mariadb',
        host: 'orders.internal',
        user: 'kodra_monitor',
        password: '${env:KODRA_DB_ORDERS_PASSWORD}',
      },
      {
        name: 'billing-replica',
        engine: 'postgres',
        host: '10.0.3.12',
        port: 5433,
        user: 'kodra_monitor',
        password: '${env:KODRA_DB_BILLING_REPLICA_PASSWORD}',
        tls: 'require',
        tunnelHost: 'bastion.example.com',
        tunnelUser: 'kodra',
        tunnelHostKey: `SHA256:${'A'.repeat(43)}`,
        tunnelKey: '${env:KODRA_DB_BILLING_REPLICA_TUNNEL_KEY}',
      },
    ]);
  });

  it('leaves the databases setting out when none are listed', () => {
    const yaml = configYaml(withDatabases());
    expect(yaml).not.toContain('KODRA_DB_');
    expect(parseAgentConfig(yaml).ok).toBe(true);
  });

  it('checks each database field, with the manifest hints', () => {
    const issues = validateDraft(
      withDatabases(
        { name: 'Orders', engine: 'mariadb', host: 'not a host', user: '' },
        { ...orders, port: '70000' },
        orders,
        { name: 'tunnel', engine: 'mysql', host: 'db', user: 'u', tunnelHost: 'bastion' },
      ),
    );
    expect(codes(issues)).toEqual([
      'connector.databases.databases.0.name:entry-name',
      'connector.databases.databases.0.host:pattern',
      'connector.databases.databases.0.user:required',
      'connector.databases.databases.1.port:integer-range',
      'connector.databases.databases.2.name:entry-duplicate',
      'connector.databases.databases.3.tunnelUser:required',
      'connector.databases.databases.3.tunnelHostKey:required',
    ]);
    expect(issues.every((i) => i.step === 'connectors')).toBe(true);
  });

  it('keeps databases in a shared link, without secrets or unknown fields', () => {
    const draft = withDatabases(orders, tunnelled);
    expect(decodeDraft(encodeDraft(draft))).toEqual({ ok: true, draft });

    const crafted = withDatabases({
      ...orders,
      password: '${env:ANTHROPIC_API_KEY}',
      tunnelKey: 'x',
      surprise: 'y',
    });
    const decoded = decodeDraft(encodeDraft(crafted));
    expect(decoded.ok && decoded.draft.connectors['databases']?.entries).toEqual({
      databases: [orders],
    });
  });

  it('cuts a crafted link to the most databases the connector allows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...orders, name: `db${String(i)}` }));
    const decoded = decodeDraft(encodeDraft(withDatabases(...many)));
    expect(
      decoded.ok && decoded.draft.connectors['databases']?.entries?.['databases'],
    ).toHaveLength(20);
  });
});

describe('databases in the bundle', () => {
  const draft = withDatabases(orders, tunnelled);

  it('lists each database secret in .env.example with how to create it', () => {
    const env = file(draft, '.env.example');
    expect(env).toContain('# Databases (orders): The database user’s password.');
    expect(env).toContain('KODRA_DB_ORDERS_PASSWORD=');
    expect(env).toContain('KODRA_DB_BILLING_REPLICA_PASSWORD=');
    expect(env).toContain('KODRA_DB_BILLING_REPLICA_TUNNEL_KEY=');
  });

  it('asks for a tunnel key only for a database with a tunnel', () => {
    const env = file(draft, '.env.example');
    expect(env).not.toContain('KODRA_DB_ORDERS_TUNNEL_KEY');
  });

  it('lists the database secrets in the README', () => {
    const readme = file(draft, 'README.md');
    expect(readme).toContain('- Databases (orders): `KODRA_DB_ORDERS_PASSWORD`.');
    expect(readme).toContain(
      '- Databases (billing-replica): `KODRA_DB_BILLING_REPLICA_TUNNEL_KEY`.',
    );
  });
});

describe('the console in the README', () => {
  it('describes what the console offers and the admin sign-in', () => {
    const readme = file(composeDraft(), 'README.md');
    expect(readme).toContain('an Overview of your systems and what needs attention, a Dashboard,');
    expect(readme).toContain('Settings for the model, connectors, and secrets.');
    expect(readme).toContain('Sign in as `admin` with the password `admin`.');
  });
});
