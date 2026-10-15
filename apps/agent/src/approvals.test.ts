import { describe, expect, it } from 'vitest';
import { resolvePolicy } from '@kodra-agent/schema';
import { memoryTerminal } from './io.ts';
import { Redactor } from './redactor.ts';
import {
  cliApprovalChannel,
  fanOut,
  newApprovalRequest,
  progressLabel,
  requesterOf,
  rulesFor,
  type ApprovalOutcome,
  type SettleableChannel,
} from './approvals.ts';
import { scriptedPrompter, testRules } from './test-helpers.ts';

function channel(answer: Promise<ApprovalOutcome>): SettleableChannel & { settled: string[] } {
  const settled: string[] = [];
  return {
    settled,
    request: () => answer,
    settle: (id, outcome) => {
      settled.push(`${id}:${outcome.decision}`);
      return Promise.resolve();
    },
  };
}

const never = new Promise<ApprovalOutcome>(() => undefined);
const req = newApprovalRequest(
  { connector: 'k8s', tool: 'scale', risk: 'write', args: '{}', reason: 'r', requestedBy: 'a' },
  testRules(),
);

describe('fanOut', () => {
  it('takes the first decision and closes the request everywhere', async () => {
    const slack = channel(never);
    const console = channel(Promise.resolve({ decision: 'approved', by: 'console:omar' }));
    const outcome = await fanOut([slack, console]).request(req);
    expect(outcome).toEqual({ decision: 'approved', by: 'console:omar' });
    expect(slack.settled).toEqual([`${req.id}:approved`]);
  });

  it('ignores a channel that fails while another can still answer', async () => {
    const broken = channel(Promise.reject(new Error('slack is down')));
    const console = channel(Promise.resolve({ decision: 'denied', by: 'console:omar' }));
    expect(await fanOut([broken, console]).request(req)).toMatchObject({ decision: 'denied' });
  });

  it('fails when every channel fails, and expires when there is none', async () => {
    const broken = channel(Promise.reject(new Error('slack is down')));
    const alsoBroken = channel(Promise.reject(new Error('no')));
    await expect(fanOut([broken, alsoBroken]).request(req)).rejects.toThrow('slack is down');
    expect(await fanOut([]).request(req)).toEqual({ decision: 'expired' });
  });
});

function ask(rules: Parameters<typeof testRules>[0] = {}, requestedBy = 'slack:U01ASKER') {
  return newApprovalRequest(
    { connector: 'k8s', tool: 'scale', risk: 'write', args: '{}', reason: 'r', requestedBy },
    testRules({ approvers: ['U01ASKER', 'U02', 'U03', 'console:omar'], ...rules }),
  );
}

describe('Ballot', () => {
  it('counts a listed approver, and refuses anyone else', () => {
    const req = ask();
    expect(req.ballot.vote('U99', true)).toEqual({
      kind: 'refused',
      code: 'not-listed',
      reason: 'You are not an approver for this change.',
    });
    expect(req.ballot.vote('U02', true)).toEqual({
      kind: 'decided',
      outcome: { decision: 'approved', by: 'U02' },
    });
    expect(req.ballot.vote('U03', true)).toEqual({ kind: 'closed' });
  });

  it('refuses self-approval where it is not allowed, but lets the requester deny', () => {
    const req = ask({ allowSelfApproval: false });
    expect(req.ballot.cannotApprove('U01ASKER')).toBe(
      'You asked for this change, so someone else must approve it.',
    );
    expect(req.ballot.vote('U01ASKER', true)).toMatchObject({ kind: 'refused' });
    expect(req.ballot.vote('U01ASKER', false, 'wrong one')).toEqual({
      kind: 'decided',
      outcome: { decision: 'denied', by: 'U01ASKER', note: 'wrong one' },
    });
    // Where self-approval is allowed, the requester's approval counts.
    expect(ask().ballot.vote('U01ASKER', true)).toMatchObject({ kind: 'decided' });
  });

  it('needs that many different approvers, and shows the progress', () => {
    const req = ask({ minApprovers: 2, allowSelfApproval: false });
    const seen: string[] = [];
    req.ballot.onProgress((p) => seen.push(progressLabel(p)));
    expect(req.ballot.vote('U02', true)).toEqual({
      kind: 'counted',
      progress: { approvedBy: ['U02'], needed: 2 },
    });
    expect(req.ballot.vote('U02', true)).toEqual({
      kind: 'refused',
      code: 'already-approved',
      reason: 'You already approved this. It needs another approver.',
    });
    expect(req.ballot.vote('U01ASKER', true)).toMatchObject({ kind: 'refused' });
    expect(req.ballot.vote('console:omar', true)).toEqual({
      kind: 'decided',
      outcome: { decision: 'approved', by: 'U02, console:omar' },
    });
    expect(seen).toEqual(['1 of 2 approved']);
  });

  it('ends the request at the first denial, even after an approval', () => {
    const req = ask({ minApprovers: 2 });
    req.ballot.vote('U02', true);
    expect(req.ballot.vote('U03', false)).toMatchObject({
      kind: 'decided',
      outcome: { decision: 'denied', by: 'U03' },
    });
    expect(req.ballot.vote('console:omar', true)).toEqual({ kind: 'closed' });
  });

  it('knows who asked', () => {
    expect(requesterOf('slack:U01ASKER')).toBe('U01ASKER');
    expect(requesterOf('console:omar')).toBe('console:omar');
    expect(requesterOf('agent')).toBe('cli');
    expect(requesterOf('ship')).toBe('cli');
    expect(requesterOf('monitor')).toBe('agent:monitor');
    // The whole request expires together, however many approvals it needs.
    const req = ask({ minApprovers: 2, expiresAfterMinutes: 5 });
    expect(req.expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(req.environment).toBeNull();
  });
});

describe('rulesFor', () => {
  const policy = resolvePolicy({
    profile: 'team',
    policy: { approvals: { approvers: ['U01', 'U02'], expiresAfterMinutes: 15 } },
    environments: [
      { name: 'production', production: true, namespaces: ['shop'], repos: [] },
      { name: 'staging', production: false, namespaces: ['staging'], repos: [] },
    ],
  });

  it('picks the environment, or the default policy', () => {
    expect(rulesFor(policy, { namespaces: ['shop'], repos: [] })).toMatchObject({
      ok: true,
      rules: { environment: 'production', allowSelfApproval: false },
    });
    expect(rulesFor(policy, { namespaces: ['dev'], repos: [] })).toMatchObject({
      ok: true,
      rules: { environment: null, allowSelfApproval: true },
    });
  });

  it('refuses one request across two environments', () => {
    expect(rulesFor(policy, { namespaces: ['shop', 'staging'], repos: [] })).toEqual({
      ok: false,
      reason:
        'this touches production and staging, which have different approval rules. Make one change per environment',
    });
  });
});

describe('cliApprovalChannel', () => {
  it('refuses at the terminal where self-approval is not allowed, without asking', async () => {
    const prompter = scriptedPrompter([true]);
    const term = memoryTerminal(new Redactor());
    const outcome = await cliApprovalChannel(prompter, term).request(
      ask({ allowSelfApproval: false }, 'agent'),
    );
    expect(outcome).toEqual({
      decision: 'denied',
      by: 'policy',
      note: 'You asked for this change, so someone else must approve it.',
    });
    expect(prompter.asked).toEqual([]);
  });

  it('approves at the terminal where self-approval is allowed', async () => {
    const prompter = scriptedPrompter([true]);
    const term = memoryTerminal(new Redactor());
    expect(await cliApprovalChannel(prompter, term).request(ask({}, 'agent'))).toEqual({
      decision: 'approved',
      by: 'cli',
    });
  });
});
