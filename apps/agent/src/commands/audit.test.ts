import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { main } from '../cli.ts';
import { Redactor } from '../redactor.ts';
import { configYaml, posixPath, tempDir, testContext, writeConfig } from '../test-helpers.ts';

async function setup(records: number) {
  const dir = await tempDir();
  const auditPath = join(dir, 'audit.jsonl');
  const path = await writeConfig(configYaml({ auditPath: posixPath(auditPath) }), dir);
  const log = new AuditLog(auditPath, new Redactor());
  for (let i = 0; i < records; i++) {
    await log.append({ event: 'task.start', actor: 'cli', task: `t${String(i)}`, detail: 'x' });
  }
  return { path, auditPath };
}

async function verify(path: string, json = false) {
  const t = testContext();
  const code = await main(
    ['audit', 'verify', '--config', path, ...(json ? ['--json'] : [])],
    t.ctx,
  );
  return { code, out: t.term.stdout.join('\n'), err: t.term.stderr.join('\n') };
}

describe('kodra-agent audit verify', () => {
  it('says an intact log is intact', async () => {
    const { path } = await setup(3);
    const result = await verify(path);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/is intact: 3 chained records, the newest is 3 \([0-9a-f]{16}\)\.$/);
  });

  it('says where an edited log breaks, as text and as JSON', async () => {
    const { path, auditPath } = await setup(3);
    const lines = (await readFile(auditPath, 'utf8')).split('\n');
    lines[1] = lines[1]?.replace('"t1"', '"t9"') ?? '';
    await writeFile(auditPath, lines.join('\n'));
    const text = await verify(path);
    expect(text.code).toBe(1);
    expect(text.err).toContain('is broken:');
    const json = await verify(path, true);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      problem: expect.any(String) as unknown,
    });
  });

  it('handles an empty log and a missing subcommand', async () => {
    const { path } = await setup(0);
    expect((await verify(path)).out).toContain('has no chained records yet');
    const t = testContext();
    expect(await main(['audit', '--config', path], t.ctx)).toBe(2);
  });
});
