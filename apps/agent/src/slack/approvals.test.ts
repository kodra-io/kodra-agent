import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newApprovalRequest } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { fakeSlack, tempDir } from '../test-helpers.ts';
import { resolveApprovers } from './approvers.ts';
import { APPROVE_ACTION, DENY_ACTION, SlackApprovals } from './approvals.ts';

async function setup(opts: { approvers?: string[]; minutes?: number; now?: () => Date } = {}) {
  const slack = fakeSlack();
  const auditPath = join(await tempDir(), 'audit.jsonl');
  const redactor = new Redactor();
  redactor.add('approval-canary-secret-777');
  const approvals = new SlackApprovals({
    api: slack.api,
    audit: new AuditLog(auditPath, redactor),
    redactor,
    approverIds: new Set(opts.approvers ?? ['U0APPROVER']),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const req = newApprovalRequest(
    {
      connector: 'kubernetes',
      tool: 'resources_scale',
      risk: 'write',
      args: '{"name":"web","scale":3,"note":"approval-canary-secret-777"}',
      reason: 'traffic spike',
      requestedBy: 'slack:U0ASKER',
    },
    opts.minutes ?? 15,
  );
  const audit = async () =>
    (await readFile(auditPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);
  return { slack, approvals, req, audit };
}

const buttonsOf = (blocks: unknown[] | undefined) =>
  (blocks ?? []).find((b) => (b as { type: string }).type === 'actions') as
    { elements: { action_id: string; value: string }[] } | undefined;

describe('SlackApprovals', () => {
  it('posts the request in the thread with Approve and Deny buttons', async () => {
    const { slack, approvals, req } = await setup();
    void approvals.channelFor('C0CHANNEL', '1700.0001').request(req);
    await Promise.resolve();
    const [message] = slack.posted;
    expect(message?.threadTs).toBe('1700.0001');
    expect(JSON.stringify(message?.blocks)).toContain('traffic spike');
    expect(buttonsOf(message?.blocks)?.elements.map((e) => [e.action_id, e.value])).toEqual([
      [APPROVE_ACTION, req.id],
      [DENY_ACTION, req.id],
    ]);
    // Arguments are redacted before they reach Slack.
    expect(JSON.stringify(slack.posted)).not.toContain('approval-canary-secret-777');
    await approvals.cancelAll();
  });

  it('shows a proposed change: its title, and its preview cut to fit Slack', async () => {
    const { slack, approvals, req } = await setup();
    const preview = `1. github/create_or_update_file: change values.yaml\n${'+line\n'.repeat(600)}`;
    void approvals
      .channelFor('C0CHANNEL', undefined)
      .request({ ...req, title: 'Raise replicas', preview });
    await Promise.resolve();
    const [message] = slack.posted;
    expect(message?.text).toBe('Approval (write) change "Raise replicas": needs approval');
    const blocks = JSON.stringify(message?.blocks);
    expect(blocks).toContain('*Change:* Raise replicas');
    expect(blocks).toContain('change values.yaml');
    expect(blocks).toContain('The console shows all of it.');
    for (const block of message?.blocks ?? []) {
      const text = (block as { text?: { text?: string } }).text?.text ?? '';
      expect(text.length).toBeLessThanOrEqual(3_000);
    }
    await approvals.cancelAll();
  });

  it('closes a request decided in the console, saying who decided', async () => {
    const { slack, approvals, req } = await setup();
    const channel = approvals.channelFor('C0CHANNEL', undefined);
    const outcome = channel.request(req);
    await Promise.resolve();
    await channel.settle(req.id, { decision: 'approved', by: 'console:omar' });
    expect(await outcome).toEqual({ decision: 'approved', by: 'console:omar' });
    expect(slack.updated.at(-1)?.text).toContain('approved by console:omar in the console');
  });

  it('accepts an approver’s click once and updates the message', async () => {
    const { slack, approvals, req } = await setup();
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    expect(
      await approvals.handleAction({ user: 'U0APPROVER', actionId: APPROVE_ACTION, value: req.id }),
    ).toBe('approved');
    expect(await outcome).toEqual({ decision: 'approved', by: 'U0APPROVER' });
    // A second click on the same request does nothing.
    expect(
      await approvals.handleAction({ user: 'U0APPROVER', actionId: DENY_ACTION, value: req.id }),
    ).toBe('unknown');
    expect(slack.updated).toHaveLength(1);
    expect(JSON.stringify(slack.updated[0]?.blocks)).toContain('approved by <@U0APPROVER>');
    expect(buttonsOf(slack.updated[0]?.blocks)).toBeUndefined();
  });

  it('records a deny', async () => {
    const { approvals, req } = await setup();
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    await approvals.handleAction({ user: 'U0APPROVER', actionId: DENY_ACTION, value: req.id });
    expect(await outcome).toEqual({ decision: 'denied', by: 'U0APPROVER' });
  });

  it('refuses and audits a click from someone who is not an approver', async () => {
    const { approvals, req, audit } = await setup();
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    expect(
      await approvals.handleAction({ user: 'U0SOMEONE', actionId: APPROVE_ACTION, value: req.id }),
    ).toBe('refused');
    expect(approvals.pendingCount).toBe(1);
    expect((await audit())[0]).toMatchObject({
      event: 'approval.decision',
      actor: 'U0SOMEONE',
      decision: 'blocked',
      tool: 'resources_scale',
    });
    // The real approver can still decide.
    await approvals.handleAction({ user: 'U0APPROVER', actionId: APPROVE_ACTION, value: req.id });
    expect((await outcome).decision).toBe('approved');
  });

  it('expires on its own and marks the message', async () => {
    const { slack, approvals, req } = await setup({ minutes: 0.0005 });
    const outcome = await approvals.channelFor('C0CHANNEL', undefined).request(req);
    expect(outcome).toEqual({ decision: 'expired' });
    expect(slack.updated[0]?.text).toContain('expired');
    expect(approvals.pendingCount).toBe(0);
  });

  it('does not accept a click that arrives after expiry', async () => {
    let now = new Date();
    const { approvals, req } = await setup({ now: () => now });
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    now = new Date(req.expiresAt.getTime() + 1000);
    expect(
      await approvals.handleAction({ user: 'U0APPROVER', actionId: APPROVE_ACTION, value: req.id }),
    ).toBe('refused');
    expect(await outcome).toEqual({ decision: 'expired' });
  });
});

describe('resolveApprovers', () => {
  const users = [
    { id: 'U01OMAR', name: 'omar', displayName: 'Omar A' },
    { id: 'U02SARA', name: 'sara.k', displayName: 'sara' },
    { id: 'U03ALEX', name: 'alex1', displayName: 'alex' },
    { id: 'U04ALEX', name: 'alex2', displayName: 'alex' },
  ];

  it('keeps ids and resolves handles by username or display name', () => {
    const result = resolveApprovers(['@omar', '@sara', 'U09DIRECT'], users);
    expect([...result.ids].sort()).toEqual(['U01OMAR', 'U02SARA', 'U09DIRECT']);
    expect(result.unresolved).toEqual([]);
  });

  it('matches nobody for an unknown or ambiguous name', () => {
    expect(resolveApprovers(['@nobody', '@alex'], users)).toEqual({
      ids: new Set(),
      unresolved: ['@nobody', '@alex'],
    });
  });
});
