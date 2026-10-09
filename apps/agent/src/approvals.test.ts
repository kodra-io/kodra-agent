import { describe, expect, it } from 'vitest';
import {
  fanOut,
  newApprovalRequest,
  type ApprovalOutcome,
  type SettleableChannel,
} from './approvals.ts';

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
  15,
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
