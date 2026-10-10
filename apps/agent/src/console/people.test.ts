import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { parseEnvFile } from '../env-file.ts';
import { Redactor } from '../redactor.ts';
import { fakeKubernetes, posixPath, tempDir } from '../test-helpers.ts';
import { People } from './people.ts';
import { SessionRegistry } from './server.ts';
import { SettingsStore } from './settings.ts';

const OMAR_TOKEN = 'people-omar-token-5e4d3c2b'; // gitleaks:allow

const yaml = (audit: string, target = 'compose') => `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  target: ${target}
  model:
    provider: anthropic
    name: claude-sonnet-5-5
    apiKey: \${env:ANTHROPIC_API_KEY}
  connectors: {}
  policy:
    approvals:
      # Who can approve changes.
      approvers:
        - "@omar"
        - "console:omar"
  audit:
    path: ${audit}
`;

async function setup(target = 'compose') {
  const dir = await tempDir();
  const configPath = join(dir, 'kodra-agent.yaml');
  const auditPath = join(dir, 'audit.jsonl');
  const envPath = join(dir, '.env');
  await writeFile(configPath, yaml(posixPath(auditPath), target));
  await writeFile(envPath, `# kept\nANTHROPIC_API_KEY=k\nKODRA_CONSOLE_TOKEN_OMAR=${OMAR_TOKEN}\n`);
  const redactor = new Redactor();
  const env = { ANTHROPIC_API_KEY: 'k', KODRA_CONSOLE_TOKEN_OMAR: OMAR_TOKEN };
  const store = new SettingsStore({
    configPath,
    audit: new AuditLog(auditPath, redactor),
    redactor,
    env,
    fetch: globalThis.fetch,
    kubernetes: fakeKubernetes(),
    probeTimeoutMs: 2000,
  });
  const sessions = new SessionRegistry();
  const people = new People({ store, sessions, env });
  const read = async () => ({
    config: await readFile(configPath, 'utf8'),
    env: await readFile(envPath, 'utf8'),
    audit: await readFile(auditPath, 'utf8').catch(() => ''),
  });
  return { people, sessions, redactor, read };
}

describe('People', () => {
  it('lists the shared sign-in, console approvers, other approvers, and sessions', async () => {
    const { people, sessions } = await setup();
    sessions.seen('s1', 'console:omar', Date.now());
    expect(await people.view()).toEqual({
      editable: true,
      people: [
        { who: 'console', canApprove: false, tokenSet: false, envVar: 'KODRA_CONSOLE_TOKEN' },
        {
          who: 'console:omar',
          canApprove: true,
          tokenSet: true,
          envVar: 'KODRA_CONSOLE_TOKEN_OMAR',
        },
      ],
      otherApprovers: ['@omar'],
      sessions: [expect.objectContaining({ id: 's1', user: 'console:omar' })],
    });
  });

  it('adds an approver with a new token that is written to .env, never to the audit log', async () => {
    const { people, redactor, read } = await setup();
    const result = await people.add('on-call', 'console:omar');
    expect(result.ok).toBe(true);
    const token = result.ok ? (result.token ?? '') : '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const after = await read();
    expect(after.config).toContain('# Who can approve changes.');
    expect(after.config).toMatch(/- "?console:on-call"?/);
    const env = parseEnvFile(after.env);
    expect(env.get('KODRA_CONSOLE_TOKEN_ON_CALL')).toBe(token);
    expect(env.get('KODRA_CONSOLE_TOKEN_OMAR')).toBe(OMAR_TOKEN);
    expect(after.env).toContain('# kept');
    expect(after.audit).toContain('added console:on-call as an approver');
    expect(after.audit).not.toContain(token);
    expect(redactor.redact(`token ${token}`)).not.toContain(token);
  });

  it('refuses a bad name or someone who is already an approver', async () => {
    const { people, read } = await setup();
    const before = await read();
    expect(await people.add('On Call!', 'console:omar')).toMatchObject({ ok: false, status: 400 });
    expect(await people.add('console:omar', 'console:omar')).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await read()).toEqual(before);
  });

  it('rotates the shared token and an approver token', async () => {
    const { people, read } = await setup();
    const shared = await people.rotate('console', 'console:omar');
    const omar = await people.rotate('console:omar', 'console:omar');
    const env = parseEnvFile((await read()).env);
    expect(shared.ok && env.get('KODRA_CONSOLE_TOKEN') === shared.token).toBe(true);
    expect(omar.ok && env.get('KODRA_CONSOLE_TOKEN_OMAR') === omar.token).toBe(true);
    expect(env.get('KODRA_CONSOLE_TOKEN_OMAR')).not.toBe(OMAR_TOKEN);
    const { audit } = await read();
    expect(audit).toContain('rotated the console token for console:omar');
    expect(audit).not.toContain(omar.ok ? omar.token : 'x');
    expect(await people.rotate('console:nobody', 'console:omar')).toMatchObject({ status: 404 });
  });

  it('removes an approver and their token, but keeps the last console approver', async () => {
    const { people, read } = await setup();
    expect(await people.remove('console:omar', 'console:omar')).toMatchObject({
      ok: false,
      status: 409,
    });
    await people.add('on-call', 'console:omar');
    expect(await people.remove('console:omar', 'console:omar')).toEqual({ ok: true });
    const after = await read();
    expect(after.config).not.toContain('console:omar');
    expect(parseEnvFile(after.env).has('KODRA_CONSOLE_TOKEN_OMAR')).toBe(false);
    expect(parseEnvFile(after.env).has('KODRA_CONSOLE_TOKEN_ON_CALL')).toBe(true);
    expect(after.audit).toContain('removed console:omar as an approver');
    expect(await people.remove('@omar', 'console:on-call')).toMatchObject({ status: 404 });
  });

  it('signs a session out, and changes nothing on Kubernetes', async () => {
    const { people, sessions } = await setup();
    sessions.seen('s1', 'console', Date.now());
    expect(await people.signOut('s1')).toEqual({ ok: true });
    expect(sessions.isRevoked('s1')).toBe(true);
    expect(await people.signOut('s1')).toMatchObject({ status: 404 });

    const k8s = await setup('kubernetes');
    const before = await k8s.read();
    expect((await k8s.people.view()).editable).toBe(false);
    for (const result of [
      await k8s.people.add('on-call', 'console:omar'),
      await k8s.people.rotate('console', 'console:omar'),
      await k8s.people.remove('console:omar', 'console:omar'),
    ]) {
      expect(result).toMatchObject({ ok: false, status: 409 });
    }
    expect(await k8s.read()).toEqual(before);
  });
});
