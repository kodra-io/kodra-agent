import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.ts';
import { REDACTED, Redactor } from './redactor.ts';
import { tempDir } from './test-helpers.ts';

const fixedNow = () => new Date('2026-10-02T12:00:00.000Z');

async function lines(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('AuditLog', () => {
  it('appends one JSON record per event, in order, keeping earlier content', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'audit.jsonl');
    const log = new AuditLog(path, new Redactor(), { now: fixedNow });
    await Promise.all([
      log.append({ event: 'task.start', actor: 'cli', task: 'doctor' }),
      log.append({
        event: 'tool.call',
        actor: 'agent',
        connector: 'github',
        tool: 'get_repo',
        risk: 'read',
        decision: 'allowed',
      }),
      log.append({ event: 'result', actor: 'cli', detail: 'done' }),
    ]);
    const records = await lines(path);
    expect(records.map((r) => r['event'])).toEqual(['task.start', 'tool.call', 'result']);
    expect(records[0]).toEqual({
      ts: '2026-10-02T12:00:00.000Z',
      event: 'task.start',
      actor: 'cli',
      task: 'doctor',
    });

    const again = new AuditLog(path, new Redactor(), { now: fixedNow });
    await again.append({ event: 'error', actor: 'cli', detail: 'later' });
    expect((await lines(path)).map((r) => r['event'])).toEqual([
      'task.start',
      'tool.call',
      'result',
      'error',
    ]);
  });

  it('redacts secrets in every field before writing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');
    const redactor = new Redactor();
    redactor.add('audit-canary-value-42');
    const log = new AuditLog(path, redactor);
    await log.append({
      event: 'tool.call',
      actor: 'agent',
      detail: 'args: {"token":"audit-canary-value-42"}',
    });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('audit-canary-value-42');
    expect(text).toContain(REDACTED);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  it('rejects records that do not match the schema', async () => {
    const log = new AuditLog(join(await tempDir(), 'a.jsonl'), new Redactor());
    await expect(log.append({ event: 'nope' as 'result', actor: 'cli' })).rejects.toThrow();
    await expect(log.append({ event: 'result', actor: '' })).rejects.toThrow();
  });

  it('rotates by size and keeps a fixed number of old files', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path, new Redactor(), { maxBytes: 200, keep: 2, now: fixedNow });
    for (let i = 0; i < 12; i++) {
      await log.append({ event: 'result', actor: 'cli', detail: `event number ${String(i)}` });
    }
    expect((await readdir(dir)).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']);
    for (const f of ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']) {
      expect((await stat(join(dir, f))).size).toBeLessThanOrEqual(200);
    }
    const newest = await lines(path);
    expect(newest.at(-1)?.['detail']).toBe('event number 11');
  });

  it.skipIf(process.platform === 'win32')('keeps the file owner-only', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '', { mode: 0o644 });
    await new AuditLog(path, new Redactor()).append({ event: 'result', actor: 'cli' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
