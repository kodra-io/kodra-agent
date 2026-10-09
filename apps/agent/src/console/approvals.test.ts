import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newApprovalRequest } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { tempDir } from '../test-helpers.ts';
import { ConsoleApprovals } from './approvals.ts';

const approver = { name: 'console:omar', canApprove: true };
const viewer = { name: 'console', canApprove: false };

async function setup() {
  const path = join(await tempDir(), 'audit.jsonl');
  let now = new Date('2026-10-09T10:00:00Z');
  const approvals = new ConsoleApprovals({
    audit: new AuditLog(path, new Redactor()),
    now: () => now,
  });
  const req = newApprovalRequest(
    {
      connector: 'k8s',
      tool: 'scale',
      risk: 'write',
      args: '{"replicas":3}',
      reason: 'spike',
      requestedBy: 'console',
    },
    15,
    now,
  );
  const outcome = approvals.channel.request(req);
  const audit = async () =>
    (await readFile(path, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);
  return {
    approvals,
    req,
    outcome,
    audit,
    later: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('ConsoleApprovals', () => {
  it('lists a waiting request and lets an approver decide it once', async () => {
    const { approvals, req, outcome } = await setup();
    expect(approvals.list()).toEqual([
      expect.objectContaining({
        id: req.id,
        tool: 'scale',
        reason: 'spike',
        requestedBy: 'console',
      }),
    ]);
    expect(await approvals.decide(approver, req.id, true)).toBe('approved');
    expect(await outcome).toEqual({ decision: 'approved', by: 'console:omar' });
    expect(await approvals.decide(approver, req.id, false)).toBe('unknown');
    expect(approvals.list()).toEqual([]);
  });

  it('passes a denial reason on, trimmed and capped', async () => {
    const { approvals, req, outcome } = await setup();
    await approvals.decide(approver, req.id, false, `  ${'x'.repeat(600)}  `);
    const result = await outcome;
    expect(result).toMatchObject({ decision: 'denied', by: 'console:omar' });
    expect(result.decision === 'denied' && result.note?.length).toBe(500);
  });

  it('refuses a viewer and audits who tried', async () => {
    const { approvals, req, audit } = await setup();
    expect(await approvals.decide(viewer, req.id, true)).toBe('refused');
    expect(approvals.list()).toHaveLength(1);
    expect(await audit()).toEqual([
      expect.objectContaining({
        event: 'approval.decision',
        actor: 'console',
        decision: 'blocked',
        detail: `${req.id}; click refused: not an approver`,
      }),
    ]);
  });

  it('does not count a decision after the request expired', async () => {
    const { approvals, req, outcome, later } = await setup();
    later(16 * 60_000);
    expect(await approvals.decide(approver, req.id, true)).toBe('expired');
    expect(await outcome).toEqual({ decision: 'expired' });
  });

  it('closes a request decided elsewhere, and all of them on shutdown', async () => {
    const first = await setup();
    await first.approvals.channel.settle(first.req.id, { decision: 'approved', by: 'U1' });
    expect(first.approvals.list()).toEqual([]);
    expect(await first.outcome).toEqual({ decision: 'approved', by: 'U1' });

    const second = await setup();
    second.approvals.cancelAll();
    expect(await second.outcome).toEqual({ decision: 'expired' });
  });
});
