import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { fakeKubernetes, fakeServer, json, posixPath, tempDir } from '../test-helpers.ts';
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
    configPath,
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
