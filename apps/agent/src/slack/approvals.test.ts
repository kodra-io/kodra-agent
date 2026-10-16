import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newApprovalRequest, type RequestRules } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { fakeSlack, tempDir, testRules } from '../test-helpers.ts';
import { resolveApprovers } from './approvers.ts';
import { APPROVE_ACTION, APPROVE_MODAL, DENY_ACTION, SlackApprovals } from './approvals.ts';

async function setup(
  opts: {
    approvers?: string[];
    minutes?: number;
    now?: () => Date;
    rules?: Partial<RequestRules>;
  } = {},
) {
  const slack = fakeSlack();
  const auditPath = join(await tempDir(), 'audit.jsonl');
  const redactor = new Redactor();
  redactor.add('approval-canary-secret-777');
  const approvals = new SlackApprovals({
    api: slack.api,
    audit: new AuditLog(auditPath, redactor),
    redactor,
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
    testRules({
      approvers: opts.approvers ?? ['U0APPROVER'],
      expiresAfterMinutes: opts.minutes ?? 15,
      ...opts.rules,
    }),
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

  it('needs two different approvers in production, never the requester, and shows progress', async () => {
    const { slack, approvals, req, audit } = await setup({
      approvers: ['U0ASKER', 'U0ONE', 'U0TWO'],
      rules: { environment: 'production', minApprovers: 2, allowSelfApproval: false },
    });
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    const posted = JSON.stringify(slack.posted[0]?.blocks);
    expect(posted).toContain('Environment: *production*');
    expect(posted).toContain('Needs 2 different approvers');
    expect(posted).toContain('The requester cannot approve it');

    const click = (user: string) =>
      approvals.handleAction({ user, actionId: APPROVE_ACTION, value: req.id });
    expect(await click('U0ASKER')).toBe('refused');
    expect(await click('U0ONE')).toBe('counted');
    expect(JSON.stringify(slack.updated.at(-1)?.blocks)).toContain('1 of 2 approved by <@U0ONE>');
    expect(buttonsOf(slack.updated.at(-1)?.blocks)).toBeDefined();
    expect(await click('U0ONE')).toBe('refused');
    expect(await click('U0TWO')).toBe('approved');
    expect(await outcome).toEqual({ decision: 'approved', by: 'U0ONE, U0TWO' });
    expect(JSON.stringify(slack.updated.at(-1)?.blocks)).toContain(
      'approved by <@U0ONE>, <@U0TWO>',
    );
    expect(
      (await audit()).map((r) => [r['event'], r['actor'], r['decision'], r['detail']]),
    ).toEqual([
      [
        'approval.decision',
        'U0ASKER',
        'blocked',
        `${req.id}; click refused: You asked for this change, so someone else must approve it.`,
      ],
      ['approval.vote', 'U0ONE', 'approved', `${req.id}; 1 of 2 approved`],
      [
        'approval.decision',
        'U0ONE',
        'blocked',
        `${req.id}; click refused: You already approved this. It needs another approver.`,
      ],
    ]);
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
  it('keeps user ids and console approvers, and leaves names unresolved', () => {
    const result = resolveApprovers(['@omar', 'U09DIRECT', 'W0GRID', 'console:omar']);
    expect([...result.ids].sort()).toEqual(['U09DIRECT', 'W0GRID']);
    expect(result.unresolved).toEqual(['@omar']);
  });
});

describe('SlackApprovals forms', () => {
  it('asks for a change reference in a modal, shows a bad one in place, then approves', async () => {
    const { slack, approvals, req, audit } = await setup({
      rules: { requireChangeRef: true, changeRefPattern: '^CHG[0-9]{7}$' },
    });
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    expect(JSON.stringify(slack.posted[0]?.blocks)).toContain('Needs a change reference');
    expect(
      await approvals.handleAction({
        user: 'U0APPROVER',
        actionId: APPROVE_ACTION,
        value: req.id,
        triggerId: 'trigger-1',
      }),
    ).toBe('asked');
    expect(slack.modals).toHaveLength(1);
    expect(slack.modals[0]).toMatchObject({
      triggerId: 'trigger-1',
      view: { callback_id: APPROVE_MODAL, private_metadata: req.id },
    });
    const submit = (changeRef: string) =>
      approvals.handleSubmission({
        user: 'U0APPROVER',
        callbackId: APPROVE_MODAL,
        privateMetadata: req.id,
        values: { change_ref: changeRef },
      });
    expect(await submit('chg-1')).toEqual({
      change_ref: 'The change reference does not have the required format. Expected: ^CHG[0-9]{7}$',
    });
    expect(approvals.pendingCount).toBe(1);
    expect(await submit('CHG1234567')).toBeNull();
    expect(await outcome).toEqual({
      decision: 'approved',
      by: 'U0APPROVER',
      changeRef: 'CHG1234567',
    });
    expect(JSON.stringify(slack.updated.at(-1)?.blocks)).toContain(
      'approved by <@U0APPROVER> (change CHG1234567)',
    );
    expect(await audit()).toEqual([]);
  });

  it('asks for a reason to override a freeze, and needs one', async () => {
    const freeze = { name: 'weekend', timezone: 'Asia/Amman', until: 'Sat 23:59' };
    const { slack, approvals, req } = await setup({
      rules: { environment: 'production', freeze },
    });
    const outcome = approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    expect(JSON.stringify(slack.posted[0]?.blocks)).toContain('Frozen (weekend, until Sat 23:59');
    await approvals.handleAction({
      user: 'U0APPROVER',
      actionId: APPROVE_ACTION,
      value: req.id,
      triggerId: 't',
    });
    expect(JSON.stringify(slack.modals[0]?.view)).toContain('*production is frozen*');
    const submit = (reason: string) =>
      approvals.handleSubmission({
        user: 'U0APPROVER',
        callbackId: APPROVE_MODAL,
        privateMetadata: req.id,
        values: reason ? { reason } : {},
      });
    expect(await submit('')).toEqual({
      reason: 'This environment is frozen. Approving needs a reason for the override.',
    });
    expect(await submit('Checkout is down.')).toBeNull();
    expect(await outcome).toMatchObject({ decision: 'approved', override: 'Checkout is down.' });
  });

  it('refuses a click from someone who cannot approve, without a modal', async () => {
    const { slack, approvals, req } = await setup({ rules: { requireChangeRef: true } });
    void approvals.channelFor('C0CHANNEL', undefined).request(req);
    await Promise.resolve();
    expect(
      await approvals.handleAction({
        user: 'U0SOMEONE',
        actionId: APPROVE_ACTION,
        value: req.id,
        triggerId: 't',
      }),
    ).toBe('refused');
    expect(slack.modals).toHaveLength(0);
    await approvals.cancelAll();
  });
});
