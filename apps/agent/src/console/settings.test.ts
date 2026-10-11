import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
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
import { moreAccess, patchConfigText, SettingsStore } from './settings.ts';

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
    const { client, state } = fakeSelfKubernetes(text);
    const names = { namespace: 'ops', configMap: 'agent', deployment: 'agent', secret: 'env' };
    const redactor = new Redactor();
    const store = new SettingsStore({
      backend: kubernetesBackend(client, names),
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
      backend: kubernetesBackend(client, { ...names, secret: null }),
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
