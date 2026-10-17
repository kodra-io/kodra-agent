import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configYaml,
  fakeServer,
  json,
  posixPath,
  tempDir,
  testContext,
  writeConfig,
} from '../test-helpers.ts';
import { doctor, type DoctorRow } from './doctor.ts';

type Server = Awaited<ReturnType<typeof fakeServer>>;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(model: string, connectors = '    {}') {
  const dir = await tempDir();
  const auditPath = join(dir, 'audit', 'audit.jsonl');
  const path = await writeConfig(
    configYaml({ auditPath: posixPath(auditPath), model, connectors }),
    dir,
  );
  return { dir, path, auditPath };
}

function rowsOf(t: ReturnType<typeof testContext>) {
  return (JSON.parse(t.term.stdout.join('\n')) as { ok: boolean; checks: DoctorRow[] }).checks;
}

describe('doctor', () => {
  it('passes a healthy setup, prints a table, and exits 0', async () => {
    server = await fakeServer({
      '/api/tags': (_q, s) => {
        json(s, 200, { models: [] });
      },
    });
    const { path } = await setup(`    provider: ollama\n    name: m\n    baseUrl: ${server.url}`);
    const t = testContext();
    expect(await doctor({ configPath: path, json: false }, t.ctx)).toBe(0);
    const out = t.term.stdout;
    expect(out[0]).toMatch(/^STATUS {2}COMPONENT +CHECK +DETAILS$/);
    expect(
      out.some((l) => /^PASS {4}config +kodra-agent\.yaml +valid \(kodra\.io\/v1alpha1\)$/.test(l)),
    ).toBe(true);
    expect(out.some((l) => /^PASS {4}Ollama +ollama\.list-models +Ollama answers/.test(l))).toBe(
      true,
    );
    expect(out.at(-1)).toMatch(/^\d+ passed, 0 failed, 0 skipped\.$/);
  });

  it('fails with a fix hint when a secret is missing, and skips its probe', async () => {
    const { path } = await setup(
      '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
    );
    const t = testContext();
    expect(await doctor({ configPath: path, json: true }, t.ctx)).toBe(1);
    const rows = rowsOf(t);
    expect(rows.find((r) => r.check === 'Anthropic apiKey (ANTHROPIC_API_KEY)')).toEqual({
      status: 'fail',
      component: 'Anthropic',
      check: 'Anthropic apiKey (ANTHROPIC_API_KEY)',
      message: 'ANTHROPIC_API_KEY is not set',
      hint: 'Run `kodra-agent init` to set it.',
    });
    expect(rows.find((r) => r.check === 'anthropic.list-models')?.status).toBe('skip');
  });

  it('needs a kubeconfig on compose, but not inside the cluster', async () => {
    const kube =
      "    kubernetes:\n      enabled: true\n      config: {namespaces: [api]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}";
    const model = '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:9';
    const rowFor = async (target: 'compose' | 'kubernetes') => {
      const dir = await tempDir();
      const path = await writeConfig(
        configYaml({
          target,
          auditPath: posixPath(join(dir, 'audit.jsonl')),
          model,
          connectors: kube,
        }),
        dir,
      );
      const t = testContext();
      await doctor({ configPath: path, json: true }, t.ctx);
      return rowsOf(t).find((r) => r.check.startsWith('Kubernetes kubeconfig'));
    };
    expect(await rowFor('compose')).toMatchObject({
      status: 'fail',
      hint: 'Copy the file into the bundle folder as secrets/kubeconfig, or run `kodra-agent init`.',
    });
    expect(await rowFor('kubernetes')).toMatchObject({ status: 'skip' });
  });

  it('reads secrets from the .env next to the config', async () => {
    server = await fakeServer({
      '/v1/models': (_q, s) => {
        json(s, 200, { data: [] });
      },
    });
    const { dir, path } = await setup(
      '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
    );
    await writeFile(join(dir, '.env'), 'ANTHROPIC_API_KEY=from-dotenv-1234\n', { mode: 0o600 }); // gitleaks:allow (fake value)
    const t = testContext({ endpoints: { anthropic: server.url }, platform: 'win32' });
    expect(await doctor({ configPath: path, json: true }, t.ctx)).toBe(0);
    expect(server.requests[0]?.headers['x-api-key']).toBe('from-dotenv-1234');
    expect(t.output()).not.toContain('from-dotenv-1234');
    expect(rowsOf(t).find((r) => r.check === '.env permissions')?.message).toContain(
      'not checked on Windows',
    );
  });

  it('flags approver names left in the config, which cannot approve', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({ auditPath: posixPath(join(dir, 'audit.jsonl')), approvers: ['@omar', 'U02'] }),
      dir,
    );
    const t = testContext();
    expect(await doctor({ configPath: path, json: true }, t.ctx)).toBe(1);
    expect(rowsOf(t).find((r) => r.check === 'approvers')).toMatchObject({
      status: 'fail',
      message: '@omar is a name, not a Slack user id, so it cannot approve',
    });
  });

  it('reports the profile and environments when approvers are ids', async () => {
    const { path } = await setup(
      '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:9',
    );
    const t = testContext();
    await doctor({ configPath: path, json: true }, t.ctx);
    expect(rowsOf(t).find((r) => r.check === 'approvers')).toMatchObject({
      status: 'pass',
      message: 'starter profile, 0 environments',
    });
  });

  it('checks the proxy and the CA file, showing only the proxy host', async () => {
    const dir = await tempDir();
    const ca = join(dir, 'ca.pem');
    await writeFile(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const network = `  network:\n    proxy:\n      https: '\${env:CORP_PROXY}'\n    caBundleFile: ${posixPath(ca)}\n`;
    const path = await writeConfig(
      configYaml({ auditPath: posixPath(join(dir, 'audit.jsonl')) }) + network,
      dir,
    );
    const missing = testContext();
    await doctor({ configPath: path, json: true }, missing.ctx);
    expect(rowsOf(missing).find((r) => r.check === 'proxy')).toMatchObject({
      status: 'fail',
      message: 'CORP_PROXY is not set',
    });
    expect(rowsOf(missing).find((r) => r.check === 'CA certificates')).toMatchObject({
      status: 'pass',
      message: `1 from ${posixPath(ca)}`,
    });

    const set = testContext({ env: { CORP_PROXY: 'http://user:pw-9f2c@proxy.corp:3128' } });
    await doctor({ configPath: path, json: true }, set.ctx);
    expect(rowsOf(set).find((r) => r.check === 'proxy')?.message).toBe(
      'through proxy.corp:3128; direct for localhost,127.0.0.1,::1,.svc,.cluster.local',
    );
    expect(set.output()).not.toContain('pw-9f2c');
  });

  it('reports an invalid config with its line numbers', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      'apiVersion: kodra.io/v1alpha1\nkind: Agent\nmetadata: {name: Bad}\n',
      dir,
    );
    const t = testContext();
    expect(await doctor({ configPath: path, json: true }, t.ctx)).toBe(1);
    const [row] = rowsOf(t);
    expect(row?.status).toBe('fail');
    expect(row?.hint).toContain(':3:');
  });

  it('fails when the audit log cannot be written', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'blocker'), 'a file, not a folder');
    const path = await writeConfig(
      configYaml({ auditPath: posixPath(join(dir, 'blocker', 'audit.jsonl')) }),
      dir,
    );
    const t = testContext();
    expect(await doctor({ configPath: path, json: true }, t.ctx)).toBe(1);
    expect(rowsOf(t).find((r) => r.component === 'audit')?.status).toBe('fail');
  });

  it('writes task.start and result records to the audit log', async () => {
    const { path, auditPath } = await setup(
      '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:1',
    );
    const t = testContext();
    await doctor({ configPath: path, json: true }, t.ctx);
    const events = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { event: string; task: string }).event);
    expect(events).toEqual(['task.start', 'result']);
  });

  it('checks the audit chain and fails when a record was edited', async () => {
    const { path, auditPath } = await setup(
      '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:1',
    );
    const first = testContext();
    await doctor({ configPath: path, json: true }, first.ctx);
    expect(rowsOf(first).find((r) => r.check === 'audit chain')).toMatchObject({
      status: 'pass',
      message: 'intact up to record 1',
    });
    const second = testContext();
    await doctor({ configPath: path, json: true }, second.ctx);
    expect(rowsOf(second).find((r) => r.check === 'audit chain')).toMatchObject({
      status: 'pass',
      message: 'intact up to record 3',
    });

    const text = await readFile(auditPath, 'utf8');
    await writeFile(auditPath, text.replace('"task.start"', '"task.started"'));
    const third = testContext();
    expect(await doctor({ configPath: path, json: true }, third.ctx)).toBe(1);
    expect(rowsOf(third).find((r) => r.check === 'audit chain')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('kodra-agent audit verify') as unknown,
    });
  });

  it.skipIf(process.platform === 'win32')('flags a .env that other users can read', async () => {
    const { dir, path } = await setup(
      '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:1',
    );
    await writeFile(join(dir, '.env'), 'X=1\n', { mode: 0o644 });
    const t = testContext();
    await doctor({ configPath: path, json: true }, t.ctx);
    expect(rowsOf(t).find((r) => r.check === '.env permissions')).toMatchObject({
      status: 'fail',
      hint: `chmod 600 ${join(dir, '.env')}`,
    });
  });
});
