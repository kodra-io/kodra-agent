import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, verifyAuditChain } from './audit.ts';
import { DataMasker } from './data-protection.ts';
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
      // The first record of a new log chains to nothing: the hash of an empty line.
      seq: 1,
      prev: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
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

describe('AuditLog and customer data (M13)', () => {
  it('records masked values as counts by type, never the values', async () => {
    const path = join(await tempDir(), 'audit.jsonl');
    const redactor = new Redactor();
    redactor.setMasker(new DataMasker({ redact: ['cards', 'emails'], patterns: [] }));
    await new AuditLog(path, redactor).append({
      event: 'tool.call',
      actor: 'agent',
      detail: 'refund to jane@example.com, card 4111 1111 1111 1111, card 5555-5555-5555-4444',
    });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('jane@example.com');
    expect(text).not.toContain('4111');
    expect(JSON.parse(text)).toMatchObject({ redactions: { email: 1, card: 2 } });
  });
});

describe('the audit hash chain (M14)', () => {
  async function chained(n: number, opts: { maxBytes?: number } = {}) {
    const path = join(await tempDir(), 'audit.jsonl');
    const log = new AuditLog(path, new Redactor(), opts);
    for (let i = 0; i < n; i++) {
      await log.append({ event: 'result', actor: 'agent', detail: `record ${String(i)}` });
    }
    return path;
  }
  const readLines = async (path: string) =>
    (await readFile(path, 'utf8')).split('\n').filter(Boolean);

  it('numbers each record and chains it to the line before', async () => {
    const path = await chained(3);
    const records = (await readLines(path)).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.map((r) => r['seq'])).toEqual([1, 2, 3]);
    const check = await verifyAuditChain(path);
    expect(check).toMatchObject({ ok: true, records: 3, unchained: 0, problem: null });
    expect(check.head?.seq).toBe(3);
  });

  it('continues across a restart and across rotation', async () => {
    const path = await chained(5, { maxBytes: 600 });
    const again = new AuditLog(path, new Redactor(), { maxBytes: 600 });
    await again.append({ event: 'result', actor: 'agent', detail: 'after a restart' });
    await expect(stat(`${path}.1`)).resolves.toBeDefined();
    expect(await verifyAuditChain(path)).toMatchObject({ ok: true, records: 6 });
  });

  it.each([
    [
      'an edited record',
      (lines: string[]) => {
        lines[1] = (lines[1] ?? '').replace('record 1', 'record one');
      },
      'record 3 does not match the record before it: one of them was edited',
    ],
    [
      'a deleted record',
      (lines: string[]) => {
        lines.splice(1, 1);
      },
      'record 3 follows 1: records were deleted or reordered',
    ],
    [
      'reordered records',
      (lines: string[]) => {
        const [a, b] = [lines[1] ?? '', lines[2] ?? ''];
        lines[1] = b;
        lines[2] = a;
      },
      'record 3 follows 1: records were deleted or reordered',
    ],
  ])('fails on %s', async (_name, tamper, problem) => {
    const path = await chained(4);
    const lines = await readLines(path);
    tamper(lines);
    await writeFile(path, `${lines.join('\n')}\n`);
    expect(await verifyAuditChain(path)).toMatchObject({ ok: false, problem });
  });

  it('accepts lines from before the chain, and refuses one added after it', async () => {
    const path = join(await tempDir(), 'audit.jsonl');
    await writeFile(path, '{"ts":"2026-10-01T00:00:00.000Z","event":"result","actor":"agent"}\n');
    const log = new AuditLog(path, new Redactor());
    await log.append({ event: 'result', actor: 'agent', detail: 'chained' });
    expect(await verifyAuditChain(path)).toMatchObject({ ok: true, records: 1, unchained: 1 });
    await writeFile(
      path,
      `${await readFile(path, 'utf8')}{"ts":"2026-10-02T00:00:00.000Z","event":"result","actor":"x"}\n`,
    );
    expect((await verifyAuditChain(path)).problem).toBe(
      'a record after 1 has no sequence number (inserted or edited)',
    );
  });

  it('hands each written line to onRecord, already redacted', async () => {
    const path = join(await tempDir(), 'audit.jsonl');
    const redactor = new Redactor();
    redactor.add('stdout-canary-secret-4411');
    const seen: string[] = [];
    await new AuditLog(path, redactor, { onRecord: (l) => seen.push(l) }).append({
      event: 'result',
      actor: 'agent',
      detail: 'token stdout-canary-secret-4411',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('stdout-canary-secret-4411');
    expect(`${seen[0] ?? ''}\n`).toBe(await readFile(path, 'utf8'));
  });
});
