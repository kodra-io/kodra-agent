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
    expect(out.some((l) => /^PASS {4}Ollama +ollama\.list-models +Ollama answers$/.test(l))).toBe(
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
