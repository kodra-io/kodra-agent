import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newApprovalRequest, type RequestRules } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { tempDir, testRules } from '../test-helpers.ts';
import { ConsoleApprovals } from './approvals.ts';

const approver = { name: 'console:omar', canApprove: true };
const viewer = { name: 'console', canApprove: false };

async function setup(rules: Partial<RequestRules> = {}, requestedBy = 'console') {
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
      requestedBy,
    },
    testRules({ approvers: ['console:omar', 'console:sara', 'U0APPROVER'], ...rules }),
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
    expect((await approvals.decide(approver, req.id, true)).result).toBe('approved');
    expect(await outcome).toEqual({ decision: 'approved', by: 'console:omar' });
    expect((await approvals.decide(approver, req.id, false)).result).toBe('unknown');
    expect(approvals.list()).toEqual([]);
  });

  it('counts approvals until enough different approvers agree', async () => {
    const sara = { name: 'console:sara', canApprove: true };
    const { approvals, req, outcome } = await setup(
      { environment: 'production', minApprovers: 2, allowSelfApproval: false },
      'console:omar',
    );
    // The requester sees why they cannot approve; another approver can.
    expect(approvals.list(approver)[0]).toMatchObject({
      environment: 'production',
      needed: 2,
      approvedBy: [],
      cannotApprove: 'You asked for this change, so someone else must approve it.',
    });
    expect(approvals.list(viewer)[0]?.cannotApprove).toBe('Only a console approver can decide.');
    expect(await approvals.decide(approver, req.id, true)).toEqual({
      result: 'refused',
      reason: 'You asked for this change, so someone else must approve it.',
    });
    expect(await approvals.decide(sara, req.id, true)).toEqual({ result: 'counted' });
    expect(approvals.list(sara)[0]).toMatchObject({
      approvedBy: ['console:sara'],
      cannotApprove: 'You already approved this. It needs another approver.',
    });
    req.ballot.vote('U0APPROVER', true);
    // A vote from Slack decides it; the agent settles every channel with the outcome.
    await approvals.channel.settle(req.id, {
      decision: 'approved',
      by: 'console:sara, U0APPROVER',
    });
    expect(await outcome).toEqual({ decision: 'approved', by: 'console:sara, U0APPROVER' });
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
    expect((await approvals.decide(viewer, req.id, true)).result).toBe('refused');
    expect(approvals.list()).toHaveLength(1);
    expect(await audit()).toEqual([
      expect.objectContaining({
        event: 'approval.decision',
        actor: 'console',
        decision: 'blocked',
        detail: `${req.id}; click refused: Only a console approver can decide.`,
      }),
    ]);
  });

  it('does not count a decision after the request expired', async () => {
    const { approvals, req, outcome, later } = await setup();
    later(16 * 60_000);
    expect((await approvals.decide(approver, req.id, true)).result).toBe('expired');
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
