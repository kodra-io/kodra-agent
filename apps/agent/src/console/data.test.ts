import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { tempDir } from '../test-helpers.ts';
import { activity, approvals, InvestigationLog, priceFor, usage } from './data.ts';

const rec = (r: Partial<AuditRecord> & Pick<AuditRecord, 'ts' | 'event'>): AuditRecord => ({
  actor: 'agent',
  ...r,
});

const records: AuditRecord[] = [
  rec({ ts: '2026-10-08T10:00:00.000Z', event: 'task.start', task: 'chat-1' }),
  rec({
    ts: '2026-10-08T10:00:01.000Z',
    event: 'model.call',
    task: 'chat-1',
    model: 'anthropic/claude-sonnet-5-5',
    usage: { input: 30_000, cacheRead: 0, cacheWrite: 28_000, output: 200 },
  }),
  rec({
    ts: '2026-10-08T10:00:02.000Z',
    event: 'tool.call',
    task: 'chat-1',
    connector: 'kubernetes',
    tool: 'pods_list_in_namespace',
    risk: 'read',
    decision: 'allowed',
    detail: 'ok; args {"namespace":"dev"}',
  }),
  rec({
    ts: '2026-10-09T09:00:00.000Z',
    event: 'model.call',
    task: 'chat-2',
    actor: 'slack:U1',
    usage: { input: 30_000, cacheRead: 29_000, cacheWrite: 0, output: 300 },
  }),
  rec({
    ts: '2026-10-09T09:00:05.000Z',
    event: 'approval.request',
    actor: 'slack:U1',
    connector: 'kubernetes',
    tool: 'resources_scale',
    risk: 'write',
    detail: 'req-1; args {"name":"web","scale":3}',
  }),
  rec({
    ts: '2026-10-09T09:00:06.000Z',
    event: 'approval.decision',
    actor: 'U-STRANGER',
    decision: 'blocked',
    detail: 'req-1',
  }),
  rec({
    ts: '2026-10-09T09:00:07.000Z',
    event: 'approval.decision',
    actor: 'U-OMAR',
    decision: 'approved',
    detail: 'req-1',
  }),
  rec({
    ts: '2026-10-09T09:01:00.000Z',
    event: 'approval.request',
    actor: 'agent',
    connector: 'github',
    tool: 'create_pull_request',
    risk: 'write',
    detail: 'req-2; args {"head":"fix"}',
  }),
];

describe('console data', () => {
  it('lists activity newest first, filtered and searchable', () => {
    expect(activity(records, {}).map((r) => r.ts)[0]).toBe('2026-10-09T09:01:00.000Z');
    expect(activity(records, { connector: 'kubernetes', event: 'tool.call' })).toHaveLength(1);
    expect(activity(records, { decision: 'blocked' }).map((r) => r.actor)).toEqual(['U-STRANGER']);
    expect(activity(records, { q: 'NAMESPACE' }).map((r) => r.tool)).toEqual([
      'pods_list_in_namespace',
    ]);
    expect(activity(records, { limit: 2 })).toHaveLength(2);
    expect(activity(records, { before: '2026-10-09T00:00:00.000Z' })).toHaveLength(3);
  });

  it('adds up usage per day and per question, with an estimated cost from list prices', () => {
    const view = usage(records, 'anthropic/claude-sonnet-5-5', undefined);
    expect(view.pricing).toMatchObject({ asOf: '2026-09-25', overridden: false });
    expect(view.totals).toMatchObject({ calls: 2, input: 60_000, cacheRead: 29_000, output: 500 });
    // Day 1: 2,000 uncached x $2 + 28,000 cache writes x $2.50 + 200 out x $10 (per million).
    expect(view.days.find((d) => d.day === '2026-10-08')?.cost).toBe(0.076);
    // Day 2: 1,000 x $2 + 29,000 cached x $0.20 + 300 x $10.
    expect(view.days.find((d) => d.day === '2026-10-09')?.cost).toBe(0.0108);
    expect(view.questions.map((q) => q.task)).toEqual(['chat-2', 'chat-1']);
  });

  it('shows tokens only when no price is known, and uses the config override', () => {
    expect(usage(records, 'openai/some-model', undefined).totals.cost).toBeNull();
    expect(usage(records, 'openai/some-model', undefined).pricing).toBeNull();
    const override = { inputPerMTok: 1, outputPerMTok: 1 };
    expect(priceFor('openai/some-model', override)).toMatchObject({ overridden: true });
    expect(usage(records, 'openai/some-model', override).totals.cost).toBe(0.0605);
  });

  it('pairs approvals with their decision, ignoring a refused click', () => {
    expect(approvals(records)).toEqual([
      expect.objectContaining({ id: 'req-2', tool: 'create_pull_request', decision: null }),
      expect.objectContaining({
        id: 'req-1',
        args: '{"name":"web","scale":3}',
        requestedBy: 'slack:U1',
        decision: 'approved',
        decidedBy: 'U-OMAR',
      }),
    ]);
  });

  it('keeps investigation findings, redacted, newest first', async () => {
    const redactor = new Redactor();
    redactor.add('investigation-canary-3a9c');
    const log = new InvestigationLog(join(await tempDir(), 'audit.jsonl'), redactor);
    await log.append({ ts: '1', alert: 'A', severity: 'warning', summary: 's', findings: 'one' });
    await log.append({
      ts: '2',
      alert: 'B',
      severity: 'critical',
      summary: 's',
      findings: 'token investigation-canary-3a9c leaked',
    });
    const list = await log.list();
    expect(list.map((i) => i.alert)).toEqual(['B', 'A']);
    expect(JSON.stringify(list)).not.toContain('investigation-canary-3a9c');
  });
});
