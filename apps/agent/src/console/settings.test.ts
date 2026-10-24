import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { getConnector, parseAgentConfig } from '@kodra-agent/connectors';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import {
  fakeKubernetes,
  fakeSelfKubernetes,
  fakeServer,
  json,
  posixPath,
  tempDir,
} from '../test-helpers.ts';
import { CONFIG_KEY, fileBackend, kubernetesBackend } from './config-backend.ts';
import { moreAccess, patchConfigText, setSecretRef, SettingsStore } from './settings.ts';

const NEW_TOKEN = 'glpat-settings-new-token-4d1c2b3a'; // gitleaks:allow
const WRONG_TOKEN = 'glpat-wrong-token-0000000000'; // gitleaks:allow

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const yaml = (gitlabUrl: string, audit: string) => `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  target: compose
  model:
    provider: anthropic
    name: claude-sonnet-5-5
    apiKey: \${env:ANTHROPIC_API_KEY}
  connectors:
    # The team's GitLab.
    gitlab:
      enabled: true
      access: read-only
      config:
        url: ${gitlabUrl}
        projects:
          - acme/api
      secrets:
        token: \${env:GITLAB_TOKEN}
  policy:
    approvals:
      approvers:
        - "@omar"
        - "console:omar"
  audit:
    path: ${audit}
`;

async function setup(gitlabUrl = 'https://gitlab.example.com') {
  const dir = await tempDir();
  const configPath = join(dir, 'kodra-agent.yaml');
  const auditPath = join(dir, 'audit.jsonl');
  await writeFile(configPath, yaml(gitlabUrl, posixPath(auditPath)));
  const redactor = new Redactor();
  const store = new SettingsStore({
    backend: fileBackend(configPath),
    audit: new AuditLog(auditPath, redactor),
    redactor,
    env: { ANTHROPIC_API_KEY: 'k', GITLAB_TOKEN: 'old-token-1234' },
    fetch: globalThis.fetch,
    kubernetes: fakeKubernetes(),
    probeTimeoutMs: 2000,
  });
  const audit = async () =>
    (await readFile(auditPath, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);
  return { dir, configPath, store, audit };
}

describe('patchConfigText', () => {
  it('changes values and keeps the comments; a new connector gets its secrets', () => {
    const text = yaml('https://gitlab.example.com', '/var/lib/kodra-agent/audit.jsonl');
    const next = patchConfigText(text, {
      connectors: {
        gitlab: { access: 'read-write-approved', config: { projects: ['acme/api', 'acme/web'] } },
        github: { enabled: true, config: { repos: ['acme/site'] } },
      },
      limits: { monthlyBudgetUsd: 40 },
    });
    expect(next).toContain("# The team's GitLab.");
    expect(next).toContain('access: read-write-approved');
    expect(next).toContain('- acme/web');
    expect(next).toContain('token: ${env:GITHUB_TOKEN}');
    expect(next).toContain('monthlyBudgetUsd: 40');
    expect(parseAgentConfig(next).ok).toBe(true);
    expect(patchConfigText(next, { limits: { monthlyBudgetUsd: null } })).not.toContain(
      'monthlyBudgetUsd',
    );
  });

  it('says what access a change adds', () => {
    const text = yaml('https://gitlab.example.com', '/var/lib/kodra-agent/audit.jsonl');
    const before = parseAgentConfig(text);
    const after = parseAgentConfig(
      patchConfigText(text, {
        connectors: {
          gitlab: { access: 'read-write-approved', config: { projects: ['acme/api', 'acme/web'] } },
          github: { enabled: true, config: { repos: ['acme/site'] } },
        },
        policy: {
          approvers: ['@omar', 'console:omar', 'console:sara'],
          destructiveActions: 'require-approval',
        },
      }),
    );
    if (!before.ok || !after.ok) throw new Error('invalid');
    const changes = moreAccess(before.config, after.config);
    expect(changes).toHaveLength(5);
    expect(changes).toEqual(
      expect.arrayContaining([
        { code: 'write', connector: 'gitlab' },
        { code: 'scope', connector: 'gitlab', field: 'projects', added: ['acme/web'] },
        { code: 'enabled', connector: 'github' },
        { code: 'approver', approver: 'console:sara' },
        { code: 'destructive' },
      ]),
    );
  });
});

describe('SettingsStore', () => {
  it('previews a diff, saves with a backup, refuses a stale save, and undoes', async () => {
    const { configPath, store, audit } = await setup();
    const original = await readFile(configPath, 'utf8');
    const patch = { connectors: { gitlab: { access: 'read-write-approved' as const } } };
    const preview = await store.preview(patch);
    expect(preview.ok).toBe(true);
    expect(preview.diff).toContain('-      access: read-only\n+      access: read-write-approved');
    expect(preview.moreAccess).toEqual([{ code: 'write', connector: 'gitlab' }]);

    expect(await store.apply(patch, 'not-the-base', 'console:omar')).toBe('stale');
    const applied = await store.apply(patch, preview.base, 'console:omar');
    expect(applied).not.toBe('stale');
    expect(await readFile(configPath, 'utf8')).toContain('access: read-write-approved');
    expect(await readFile(`${configPath}.previous`, 'utf8')).toBe(original);
    expect((await store.view(null)).undoable).toBe(true);

    expect(await store.undo('console:omar')).toBe(true);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect((await audit()).map((r) => `${r['event']}:${r['actor']}:${r['detail']}`)).toEqual([
      'settings:console:omar:changed gitlab.access',
      'settings:console:omar:undid the last change',
    ]);
  });

  it('refuses invalid settings, turning the console off, or removing the last console approver', async () => {
    const { store } = await setup();
    expect((await store.preview({ limits: { maxSteps: 0 } })).errors.join()).toContain('maxSteps');
    expect((await store.preview({ connectors: { nope: { enabled: true } } })).errors).toEqual([
      'unknown connector nope',
    ]);
    expect((await store.preview({ policy: { approvers: ['@omar'] } })).errors).toEqual([
      'keep at least one console approver, or nobody could change settings here',
    ]);
  });

  it('checks a new token before saving it to .env, and never writes or logs a bad one', async () => {
    server = await fakeServer({
      '/api/v4/projects/acme%2Fapi': (req, res) => {
        json(res, req.headers['private-token'] === NEW_TOKEN ? 200 : 401, {});
      },
    });
    const { dir, store, audit } = await setup(server.url);
    const bad = await store.setSecret('gitlab', 'token', WRONG_TOKEN, 'console:omar');
    expect(bad.status).toBe('fail');
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();

    const good = await store.setSecret('gitlab', 'token', NEW_TOKEN, 'console:omar');
    expect(good.status).toBe('pass');
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain(`GITLAB_TOKEN=${NEW_TOKEN}`);
    const records = JSON.stringify(await audit());
    expect(records).toContain('replaced GitLab token (GITLAB_TOKEN)');
    expect(records).not.toContain(NEW_TOKEN);

    const view = await store.view(null);
    const gitlab = view.connectors.find((c) => c.id === 'gitlab');
    expect(gitlab?.secrets[0]).toMatchObject({ key: 'token', set: true, writable: true });
    expect(JSON.stringify(view)).not.toContain('old-token-1234');
  });

  it('on Kubernetes, saves to its own ConfigMap and Secret', async () => {
    server = await fakeServer({
      '/api/v4/projects/acme%2Fapi': (req, res) => {
        json(res, req.headers['private-token'] === NEW_TOKEN ? 200 : 401, {});
      },
    });
    const files = await setup(server.url);
    const text = (await readFile(files.configPath, 'utf8')).replace(
      'target: compose',
      'target: kubernetes',
    );
    const { client, state } = fakeSelfKubernetes();
    const names = {
      namespace: 'ops',
      configMap: 'agent-settings',
      deployment: 'agent',
      secret: 'env',
      settingsDir: '/etc/kodra-agent-settings',
    };
    const redactor = new Redactor();
    const store = new SettingsStore({
      backend: kubernetesBackend(client, names, text),
      audit: new AuditLog(join(files.dir, 'audit.jsonl'), redactor),
      redactor,
      env: { ANTHROPIC_API_KEY: 'k', GITLAB_TOKEN: 'old-token-1234' },
      fetch: globalThis.fetch,
      kubernetes: fakeKubernetes(),
      probeTimeoutMs: 2000,
    });
    const view = await store.view(null);
    expect(view).toMatchObject({ target: 'kubernetes', editable: true, why: null });
    expect(view.connectors.find((c) => c.id === 'gitlab')?.secrets[0]?.writable).toBe(true);

    const patch = { limits: { monthlyBudgetUsd: 25 } };
    const preview = await store.preview(patch);
    expect(await store.apply(patch, preview.base, 'console:omar')).toMatchObject({ ok: true });
    expect(state.configMap[CONFIG_KEY]).toContain('monthlyBudgetUsd: 25');
    expect(await store.setSecret('gitlab', 'token', NEW_TOKEN, 'console:omar')).toMatchObject({
      status: 'pass',
    });
    expect(state.secret).toEqual({ GITLAB_TOKEN: NEW_TOKEN });
    expect(await store.undo('console:omar')).toBe(true);
    expect(state.configMap[CONFIG_KEY]).toBe(text);

    // Without the agent's Secret, the config is editable but secrets are not.
    const noSecret = new SettingsStore({
      backend: kubernetesBackend(client, { ...names, secret: null }, text),
      audit: new AuditLog(join(files.dir, 'audit.jsonl'), redactor),
      redactor,
      env: {},
      fetch: globalThis.fetch,
      kubernetes: fakeKubernetes(),
      probeTimeoutMs: 2000,
    });
    const limited = await noSecret.view(null);
    expect(limited.editable).toBe(true);
    expect(limited.connectors.find((c) => c.id === 'gitlab')?.secrets[0]?.writable).toBe(false);
    expect(await noSecret.canEditSecrets()).toBe(false);
  });

  it('is read-only when the config does not live where the agent can change it', async () => {
    const files = await setup();
    await writeFile(
      files.configPath,
      (await readFile(files.configPath, 'utf8')).replace('target: compose', 'target: kubernetes'),
    );
    const before = await readFile(files.configPath, 'utf8');
    const view = await files.store.view(null);
    expect(view).toMatchObject({ editable: false, why: 'kubernetes', undoable: false });
    const patch = { limits: { monthlyBudgetUsd: 25 } };
    const result = await files.store.apply(patch, view.base, 'console:omar');
    expect(result).toMatchObject({ ok: false, errors: ['settings cannot be changed here'] });
    expect(await files.store.setSecret('gitlab', 'token', NEW_TOKEN, 'console:omar')).toMatchObject(
      { status: 'fail' },
    );
    expect(await readFile(files.configPath, 'utf8')).toBe(before);
  });

  it('tests a connection the way doctor does', async () => {
    server = await fakeServer({
      '/api/v4/projects/acme%2Fapi': (_req, res) => {
        json(res, 401, {});
      },
    });
    const { store } = await setup(server.url);
    const rows = await store.test('gitlab');
    expect(rows).toEqual([
      expect.objectContaining({ check: 'gitlab.read-projects', status: 'fail' }),
    ]);
  });
});

describe('databases from the console', () => {
  const withDatabases = (entries: string) =>
    yaml('https://gitlab.example.com', '/var/lib/kodra-agent/audit.jsonl').replace(
      '  policy:',
      `    databases:
      enabled: true
      access: read-only
      config:
        databases:
${entries}  policy:`,
    );

  it('names each secret for its database, whatever reference the console sends', () => {
    const next = patchConfigText(withDatabases(''), {
      connectors: {
        databases: {
          config: {
            databases: [
              {
                name: 'orders',
                engine: 'mariadb',
                host: 'db.internal',
                user: 'monitor',
                // Hostile: pointing a database at the model key, or at a file on the host.
                password: '${env:ANTHROPIC_API_KEY}',
                tunnelKey: '${file:/etc/shadow}',
              },
            ],
          },
        },
      },
    });
    expect(next).toContain('password: ${env:KODRA_DB_ORDERS_PASSWORD}');
    // Only the model's own reference names the model key.
    expect(next.split('ANTHROPIC_API_KEY')).toHaveLength(2);
    // No tunnel host, so no tunnel key at all.
    expect(next).not.toContain('tunnelKey');
    expect(next).not.toContain('/etc/shadow');
    expect(parseAgentConfig(next).ok).toBe(true);
  });

  it('keeps a file reference already in the file for the same database', () => {
    const text = withDatabases(`          - name: orders
            engine: postgres
            host: db.internal
            user: monitor
            password: \${file:/secrets/orders-password}
`);
    const next = patchConfigText(text, {
      connectors: {
        databases: {
          config: {
            databases: [
              { name: 'orders', engine: 'postgres', host: 'db2.internal', user: 'monitor' },
              {
                name: 'billing',
                engine: 'mysql',
                host: 'billing.internal',
                user: 'monitor',
                tunnelHost: 'bastion.example.com',
                tunnelUser: 'tunnel',
                tunnelHostKey: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
              },
            ],
          },
        },
      },
    });
    expect(next).toContain('password: ${file:/secrets/orders-password}');
    expect(next).toContain('password: ${env:KODRA_DB_BILLING_PASSWORD}');
    expect(next).toContain('tunnelKey: ${env:KODRA_DB_BILLING_TUNNEL_KEY}');
    const before = parseAgentConfig(text);
    const after = parseAgentConfig(next);
    if (!before.ok || !after.ok) throw new Error('invalid');
    // A new database, and one pointed somewhere new, are both new access.
    expect(moreAccess(before.config, after.config)).toEqual([
      {
        code: 'scope',
        connector: 'databases',
        field: 'databases',
        added: ['orders (db2.internal)', 'billing (billing.internal via bastion.example.com)'],
      },
    ]);
  });

  it("lists each database's secret, and tests only that database before saving it", async () => {
    const { dir, configPath, store, audit } = await setup();
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace(
        '  policy:',
        `    databases:
      enabled: true
      access: read-only
      config:
        databases:
          - name: orders
            engine: mariadb
            host: 127.0.0.1
            port: 1
            user: monitor
            password: \${env:KODRA_DB_ORDERS_PASSWORD}
            tls: 'off'
  policy:`,
      ),
    );
    const view = await store.view(null);
    const databases = view.connectors.find((c) => c.id === 'databases');
    expect(databases?.secrets).toEqual([
      expect.objectContaining({
        key: 'orders.password',
        label: 'Databases orders.password (KODRA_DB_ORDERS_PASSWORD)',
        envVar: 'KODRA_DB_ORDERS_PASSWORD',
        set: false,
        writable: true,
      }),
    ]);
    // Nothing listens on port 1: the password is not saved.
    const result = await store.setSecret(
      'databases',
      'orders.password',
      'pw-c4n4ry-1',
      'console:omar',
    );
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.message).toContain('orders: down (the connection was refused');
    expect(result.message).not.toContain('c4n4ry');
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
    expect(JSON.stringify(await audit())).not.toContain('c4n4ry');
  });
});

describe('file secrets from the console (M28)', () => {
  const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: prod
    cluster:
      server: https://203.0.113.10:6443
contexts:
  - name: kodra-agent
    context: { cluster: prod, user: kodra-agent }
current-context: kodra-agent
users:
  - name: kodra-agent
    user:
      token: kubeconfig-c4n4ry-token-0123456789
`;

  const withKubernetes = async (configPath: string) => {
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace(
        '  policy:',
        `    kubernetes:
      enabled: true
      access: read-only
      config:
        namespaces: [payments, web]
  policy:`,
      ),
    );
  };

  it('shows how to make a kubeconfig, then saves an uploaded one as a file the config points at', async () => {
    const { dir, configPath, store, audit } = await setup();
    await withKubernetes(configPath);
    const kubernetes = async () =>
      (await store.view(null)).connectors.find((c) => c.id === 'kubernetes');
    const before = await kubernetes();
    const secret = before?.secrets.find((s) => s.key === 'kubeconfig');
    // Needed on Docker Compose, not there yet, and the console can take it.
    expect(secret).toMatchObject({
      required: true,
      set: false,
      writable: true,
      format: 'kubeconfig',
    });
    expect(before?.missing).toEqual(['kubeconfig']);
    // The steps carry this connector's namespaces, for each system.
    const roles = secret?.steps[1]?.run;
    expect(roles?.linux).toContain('for ns in payments web; do');
    expect(roles?.windows).toContain("foreach ($ns in 'payments web'.Split(' '))");
    expect(secret?.steps.at(-1)?.run).toBeUndefined();

    // A kubeconfig without a current context is refused before anything is tried.
    const broken = await store.setSecret(
      'kubernetes',
      'kubeconfig',
      KUBECONFIG.replace('current-context: kodra-agent\n', ''),
      'console:omar',
    );
    expect(broken.status).toBe('fail');
    expect(broken.message).toContain('current-context');

    const result = await store.setSecret('kubernetes', 'kubeconfig', KUBECONFIG, 'console:omar');
    expect(result).toMatchObject({ status: 'pass' });
    const file = join(dir, 'secrets', 'kubernetes-kubeconfig');
    expect(await readFile(file, 'utf8')).toBe(KUBECONFIG);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain(`kubeconfig: \${file:${posixPath(file)}}`);
    expect(parseAgentConfig(config).ok).toBe(true);
    // Nothing went to .env, and the token is in no record.
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
    const records = JSON.stringify(await audit());
    expect(records).toContain('replaced Kubernetes kubeconfig (file ');
    expect(records).not.toContain('c4n4ry');
    const after = await kubernetes();
    expect(after?.secrets.find((s) => s.key === 'kubeconfig')).toMatchObject({ set: true });
    expect(after?.missing).toEqual([]);
  });

  it('points a database at its uploaded tunnel key, and refuses one with a passphrase', async () => {
    const { configPath, store } = await setup();
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace(
        '  policy:',
        `    databases:
      enabled: true
      access: read-only
      config:
        databases:
          - name: orders
            engine: mariadb
            host: db.internal
            port: 3306
            user: monitor
            password: \${env:KODRA_DB_ORDERS_PASSWORD}
            tunnelHost: bastion.example.com
            tunnelUser: tunnel
            tunnelHostKey: SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8
            tunnelKey: \${env:KODRA_DB_ORDERS_TUNNEL_KEY}
  policy:`,
      ),
    );
    const view = await store.view(null);
    const databases = view.connectors.find((c) => c.id === 'databases');
    const key = databases?.secrets.find((s) => s.key === 'orders.tunnelKey');
    expect(key?.format).toBe('ssh-private-key');
    // The entry's own values go into its steps; the port defaults to 22.
    expect(key?.steps[1]?.run?.linux).toContain('permitopen=\\"db.internal:3306\\"');
    expect(key?.steps[1]?.run?.linux).toContain('ssh -p 22 tunnel@bastion.example.com');
    expect(databases?.entrySteps['orders']?.['tunnelHostKey']?.[1]?.run?.macos).toBe(
      'ssh-keyscan -t ed25519 -p 22 bastion.example.com | ssh-keygen -lf -',
    );
    expect(databases?.entrySteps['']?.['tunnelHostKey']?.[1]?.run?.macos).toBe(
      'ssh-keyscan -t ed25519 -p 22 <tunnelHost> | ssh-keygen -lf -',
    );

    const locked = ssh2.utils.generateKeyPairSync('ed25519', {
      passphrase: 'p',
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    expect(
      await store.setSecret('databases', 'orders.tunnelKey', locked.private, 'console:omar'),
    ).toMatchObject({
      status: 'fail',
      message: 'that key has a passphrase; the agent cannot type one',
    });
    expect(await readFile(configPath, 'utf8')).toContain('${env:KODRA_DB_ORDERS_TUNNEL_KEY}');
  });

  it('writes the reference into the entry it belongs to, keeping the layout', () => {
    const text = `apiVersion: kodra.io/v1alpha1
spec:
  connectors:
    { databases: { config: { databases: [ { name: a, tunnelKey: "\${env:KODRA_DB_A_TUNNEL_KEY}" }, { name: b } ] } } }
`;
    const manifest = getConnector('databases');
    if (!manifest) throw new Error('no databases');
    const next = setSecretRef(text, manifest, 'a.tunnelKey', '${file:/etc/kodra-agent/secrets/x}');
    expect(next).toContain('tunnelKey: "${file:/etc/kodra-agent/secrets/x}"');
    expect(next).not.toContain('KODRA_DB_A_TUNNEL_KEY');
    expect(setSecretRef(next, manifest, 'a.tunnelKey', '${file:/etc/kodra-agent/secrets/x}')).toBe(
      next,
    );
    // An entry that is not there changes nothing.
    expect(setSecretRef(text, manifest, 'zzz.tunnelKey', '${file:/x}')).toBe(text);
  });
});

describe('trusted certificates from the console', () => {
  it('saves a CA file in the bundle, points the network at it, and can stop trusting it', async () => {
    const files = await setup();
    const pem = `${rootCertificates[0] ?? ''}\r\n${rootCertificates[1] ?? ''}`;
    expect((await files.store.view(null)).network).toMatchObject({
      caBundleFile: null,
      caWritable: true,
    });
    expect(await files.store.setCaBundle('not a certificate', 'console:omar')).toEqual({
      ok: false,
      message: 'that is not a PEM file of certificates',
    });
    expect(await files.store.setCaBundle(pem, 'console:omar')).toEqual({
      ok: true,
      certificates: 2,
    });
    const saved = join(files.dir, 'ca', 'console-ca-bundle.pem');
    expect(await readFile(saved, 'utf8')).not.toContain('\r');
    const path = posixPath(saved).replace(/^[A-Za-z]:/, '');
    expect(await readFile(files.configPath, 'utf8')).toContain(`caBundleFile: ${path}`);
    expect((await files.store.view(null)).network.caBundleFile).toBe(path);
    expect(await files.store.setCaBundle(null, 'console:omar')).toEqual({
      ok: true,
      certificates: 0,
    });
    expect(await readFile(files.configPath, 'utf8')).not.toContain('caBundleFile');
    expect((await files.audit()).map((r) => r['detail'])).toEqual([
      `trusts 2 CA certificates (file ${path})`,
      'stopped trusting the extra CA certificates',
    ]);
  });

  it('leaves Kubernetes to the chart', async () => {
    const files = await setup();
    await writeFile(
      files.configPath,
      (await readFile(files.configPath, 'utf8')).replace('target: compose', 'target: kubernetes'),
    );
    expect((await files.store.view(null)).network.caWritable).toBe(false);
    expect(await files.store.setCaBundle(rootCertificates[0] ?? '', 'console:omar')).toEqual({
      ok: false,
      message: 'trusted certificates cannot be changed here',
    });
  });
});

describe('everything else from the console (M30b)', () => {
  it('patches every section, keeping comments, and the result is a valid config', () => {
    const text = yaml('https://gitlab.example.com', '/var/lib/kodra-agent/audit.jsonl');
    const next = patchConfigText(text, {
      profile: 'team',
      policy: { minApprovers: 2, requireChangeRef: true, changeRefPattern: '^CHG[0-9]+$' },
      environments: [
        {
          name: 'production',
          production: true,
          namespaces: ['payments'],
          repos: [],
          freezes: [
            {
              name: 'weekend',
              timezone: 'Asia/Amman',
              weekly: { from: 'Fri 18:00', to: 'Sun 08:00' },
            },
          ],
        },
      ],
      checks: {
        schedules: [{ name: 'daily', at: '09:00', days: ['mon', 'tue'], timezone: 'Asia/Amman' }],
        quietWhenClean: true,
      },
      monitoring: { maxPerHour: 5 },
      network: { noProxy: 'localhost,.svc' },
      dataProtection: { redact: ['cards'], patterns: [{ name: 'order', regex: 'ORD-[0-9]{6}' }] },
      models: {
        local: { provider: 'ollama', name: 'llama3', config: { baseUrl: 'http://o:11434' } },
      },
      ship: { baseImageMirrors: { 'docker.io': 'harbor.example.com/mirror' } },
      metrics: { enabled: false },
      tracing: { enabled: true, endpoint: 'http://otel:4318/v1/traces' },
      audit: { stdout: true },
      limits: { maxWritesPerHour: 4 },
    });
    expect(next).toContain("# The team's GitLab.");
    const parsed = parseAgentConfig(next);
    if (!parsed.ok) throw new Error(parsed.issues.map((i) => i.message).join('; '));
    const spec = parsed.config.spec;
    expect(spec.profile).toBe('team');
    expect(spec.policy.approvals).toMatchObject({ minApprovers: 2, requireChangeRef: true });
    expect(spec.environments[0]?.freezes[0]?.name).toBe('weekend');
    expect(spec.checks).toMatchObject({ quietWhenClean: true });
    expect(spec.monitoring.maxPerHour).toBe(5);
    expect(spec.network.proxy?.noProxy).toBe('localhost,.svc');
    expect(spec.dataProtection.redact).toEqual(['cards']);
    expect(spec.models['local']).toMatchObject({ provider: 'ollama', name: 'llama3' });
    expect(spec.ship.baseImageMirrors).toEqual({ 'docker.io': 'harbor.example.com/mirror' });
    expect(spec.metrics.enabled).toBe(false);
    expect(spec.tracing).toMatchObject({ enabled: true });
    expect(spec.audit.stdout).toBe(true);
    expect(spec.limits.maxWritesPerHour).toBe(4);
    // null takes a rule back to the profile's default.
    const back = patchConfigText(next, { policy: { minApprovers: null } });
    expect(back).not.toContain('minApprovers');
  });

  it('says what a change gives away: a broad credential, unmasked data, a model, traces', () => {
    const withK8s = yaml('https://gitlab.example.com', '/var/lib/kodra-agent/audit.jsonl').replace(
      '  connectors:\n',
      '  connectors:\n    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n',
    );
    const before = parseAgentConfig(withK8s);
    if (!before.ok) throw new Error('bad fixture');
    const after = parseAgentConfig(
      patchConfigText(withK8s, {
        connectors: { kubernetes: { allowBroadCredentials: true } },
        dataProtection: { redact: [] },
        models: {
          local: { provider: 'ollama', name: 'llama3', config: { baseUrl: 'http://o:11434' } },
        },
        tracing: { enabled: true, endpoint: 'http://otel:4318/v1/traces' },
      }),
    );
    if (!after.ok) throw new Error(after.issues.map((i) => i.message).join('; '));
    const codes = moreAccess(before.config, after.config).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['broad', 'unmasked', 'named-model', 'tracing']));
  });

  it('saves proxy URLs as secrets, audits the host only, and removes them', async () => {
    const files = await setup();
    const proxy = 'http://user:proxy-secret-9d8c@proxy.corp:3128';
    expect(await files.store.setProxy({ https: 'ftp://nope' }, 'console:omar')).toEqual({
      ok: false,
      message: 'a proxy URL starts with http:// or https://',
    });
    expect(await files.store.setProxy({ https: proxy }, 'console:omar')).toEqual({ ok: true });
    expect(await readFile(files.configPath, 'utf8')).toContain('${env:KODRA_HTTPS_PROXY}');
    expect(await readFile(join(files.dir, '.env'), 'utf8')).toContain(`KODRA_HTTPS_PROXY=${proxy}`);
    const audited = JSON.stringify(await files.audit());
    expect(audited).toContain('set the HTTPS proxy (proxy.corp:3128)');
    expect(audited).not.toContain('proxy-secret');
    expect(await files.store.setProxy({ https: null }, 'console:omar')).toEqual({ ok: true });
    expect(await readFile(files.configPath, 'utf8')).not.toContain('KODRA_HTTPS_PROXY');
    expect(await readFile(join(files.dir, '.env'), 'utf8')).not.toContain('proxy-secret');
  });

  it('turns new Slack @names into user ids, and says when a name matches nobody', async () => {
    const files = await setup();
    await writeFile(
      files.configPath,
      (await readFile(files.configPath, 'utf8')).replace(
        '  connectors:\n',
        [
          '  connectors:',
          '    slack:',
          '      enabled: true',
          "      config: {channel: '#ops'}",
          "      secrets: {botToken: '${env:SLACK_BOT_TOKEN}', appToken: '${env:SLACK_APP_TOKEN}'}",
          '',
        ].join('\n'),
      ),
    );
    server = await fakeServer({
      '/api/users.list': (_req, res) => {
        json(res, 200, {
          ok: true,
          members: [{ id: 'U0SARA', name: 'sara', profile: { display_name: 'Sara' } }],
        });
      },
    });
    const redactor = new Redactor();
    const store = new SettingsStore({
      backend: fileBackend(files.configPath),
      audit: new AuditLog(join(files.dir, 'audit2.jsonl'), redactor),
      redactor,
      env: { ANTHROPIC_API_KEY: 'k', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' },
      fetch: globalThis.fetch,
      kubernetes: fakeKubernetes(),
      probeTimeoutMs: 2000,
      slackBase: server.url,
    });
    const ok = await store.preview({ policy: { approvers: ['@omar', 'console:omar', '@sara'] } });
    expect(ok.errors).toEqual([]);
    expect(ok.diff).toContain('U0SARA');
    const bad = await store.preview({ policy: { approvers: ['console:omar', '@nobody'] } });
    expect(bad.errors).toEqual(['@nobody matches nobody in this Slack workspace.']);
  });
});
