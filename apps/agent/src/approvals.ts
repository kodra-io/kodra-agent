import { randomUUID } from 'node:crypto';
import type { Prompter, Terminal } from './io.ts';
import type { Risk } from './policy.ts';

/** What a human is asked to approve. Arguments are already redacted. */
export interface ApprovalRequest {
  id: string;
  connector: string;
  tool: string;
  risk: Risk;
  args: string;
  /** Why the model says it needs this. */
  reason: string;
  requestedBy: string;
  expiresAt: Date;
}

export type ApprovalOutcome =
  | { decision: 'approved'; by: string }
  | { decision: 'denied'; by: string }
  | { decision: 'expired' };

/** Where approvals are asked: the CLI now, Slack buttons in M5. */
export interface ApprovalChannel {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;
}

export function newApprovalRequest(
  fields: Omit<ApprovalRequest, 'id' | 'expiresAt'>,
  expiresAfterMinutes: number,
  now: Date = new Date(),
): ApprovalRequest {
  return {
    ...fields,
    id: randomUUID(),
    expiresAt: new Date(now.getTime() + expiresAfterMinutes * 60_000),
  };
}

/**
 * Asks the person at the terminal. Anything but an explicit yes is a no, and an answer
 * after the request expired does not count.
 */
export function cliApprovalChannel(
  prompter: Prompter,
  term: Terminal,
  now: () => Date = () => new Date(),
): ApprovalChannel {
  return {
    async request(req) {
      term.out('');
      term.out(`Approval needed (${req.risk}): ${req.connector} / ${req.tool}`);
      term.out(`  Why:       ${req.reason}`);
      term.out(`  Arguments: ${req.args}`);
      term.out(`  Expires:   ${req.expiresAt.toISOString()}`);
      const ms = req.expiresAt.getTime() - now().getTime();
      if (ms <= 0) return { decision: 'expired' };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => {
          resolve('expired');
        }, ms);
      });
      try {
        const answer = await Promise.race([
          prompter.confirm('Approve this action?', false),
          timeout,
        ]);
        if (answer === 'expired' || now() > req.expiresAt) {
          term.out('  The request expired. Nothing was run.');
          return { decision: 'expired' };
        }
        return answer ? { decision: 'approved', by: 'cli' } : { decision: 'denied', by: 'cli' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
