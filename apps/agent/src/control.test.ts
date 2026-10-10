import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.ts';
import { budgetRefusal, budgetState } from './budget.ts';
import { AgentControl } from './control.ts';
import { Redactor } from './redactor.ts';
import { tempDir } from './test-helpers.ts';

describe('AgentControl', () => {
  it('pauses and resumes, audits both, tells listeners, and survives a restart', async () => {
    const dir = await tempDir();
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath, new Redactor());
    const control = new AgentControl(auditPath, audit, () => new Date('2026-10-10T10:00:00Z'));
    await control.load();
    expect(control.paused).toBeNull();
    expect(control.reason()).toBeNull();
    const seen: string[] = [];
    control.onChange((state, who) => seen.push(`${state ? 'paused' : 'resumed'} by ${who}`));

    await control.pause('console');
    expect(control.paused).toEqual({ by: 'console', at: '2026-10-10T10:00:00.000Z' });
    expect(control.reason()).toContain('changes are paused (by console)');

    // A new process reads the saved state.
    const again = new AgentControl(auditPath, audit);
    await again.load();
    expect(again.paused).toEqual({ by: 'console', at: '2026-10-10T10:00:00.000Z' });

    await control.resume('console:omar');
    await control.resume('console:omar');
    expect(control.paused).toBeNull();
    expect(seen).toEqual(['paused by console', 'resumed by console:omar']);
    const records = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(records.map((r) => `${r['event']}:${r['actor']}`)).toEqual([
      'control:console',
      'control:console:omar',
    ]);
  });

  it('treats a broken state file as not paused', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'control.json'), '{not json');
    const control = new AgentControl(
      join(dir, 'audit.jsonl'),
      new AuditLog(join(dir, 'audit.jsonl'), new Redactor()),
    );
    await control.load();
    expect(control.paused).toBeNull();
  });
});

describe('budgetState', () => {
  const call = (ts: string, input: number, output: number) =>
    JSON.stringify({
      ts,
      event: 'model.call',
      actor: 'agent',
      usage: { input, cacheRead: 0, cacheWrite: 0, output },
    });

  it("counts this month's model calls at the model's price", async () => {
    const dir = await tempDir();
    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(
      auditPath,
      [
        call('2026-09-30T23:59:00.000Z', 9_000_000, 0),
        call('2026-10-01T00:00:00.000Z', 1_000_000, 100_000),
        call('2026-10-09T12:00:00.000Z', 1_000_000, 100_000),
      ].join('\n') + '\n',
    );
    const pricing = { inputPerMTok: 2, outputPerMTok: 10 };
    const state = await budgetState({
      auditPath,
      model: 'anthropic/claude-sonnet-5-5',
      pricing,
      limit: 5,
      now: new Date('2026-10-10T08:00:00Z'),
    });
    // October only: 2M in at $2, 200k out at $10.
    expect(state).toEqual({ month: '2026-10', limit: 5, spent: 6, over: true });
    expect(budgetRefusal(state)).toContain('The monthly budget of $5.00 is used up (about $6.00');

    const under = await budgetState({
      auditPath,
      model: 'x/y',
      pricing,
      limit: 50,
      now: new Date('2026-10-10T08:00:00Z'),
    });
    expect(under.over).toBe(false);
    expect(budgetRefusal(under)).toBeNull();
  });

  it('has no spend without a known price, and no refusal without a limit', async () => {
    const dir = await tempDir();
    const state = await budgetState({
      auditPath: join(dir, 'audit.jsonl'),
      model: 'ollama/llama',
      pricing: undefined,
      limit: 1,
    });
    expect(state.spent).toBeNull();
    expect(state.over).toBe(false);
    const noLimit = await budgetState({
      auditPath: join(dir, 'audit.jsonl'),
      model: 'anthropic/claude-sonnet-5-5',
      pricing: undefined,
      limit: undefined,
    });
    expect(noLimit).toMatchObject({ limit: null, spent: 0, over: false });
  });
});
