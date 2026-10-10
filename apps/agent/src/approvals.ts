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
  /** A proposed change: its one-line title and the readable preview (a diff for file edits). */
  title?: string;
  preview?: string;
}

export type ApprovalOutcome =
  | { decision: 'approved'; by: string }
  | { decision: 'denied'; by: string; note?: string }
  | { decision: 'expired' };

/** Where approvals are asked: the terminal, Slack buttons, or the console. */
export interface ApprovalChannel {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;
}

/** A channel that can also be told a request was decided elsewhere, to close it there. */
export interface SettleableChannel extends ApprovalChannel {
  settle(id: string, outcome: ApprovalOutcome): Promise<void>;
}

/**
 * Asks every channel at once (Slack and the console); the first decision wins and the
 * others are closed with it. A channel that fails to ask is ignored while another can
 * still answer. With no channel at all, nobody can approve, so the request expires.
 */
export function fanOut(channels: readonly SettleableChannel[]): ApprovalChannel {
  const [only] = channels;
  if (channels.length === 1 && only) return only;
  return {
    async request(req) {
      if (channels.length === 0) return { decision: 'expired' };
      let outcome: ApprovalOutcome;
      try {
        outcome = await Promise.any(channels.map((c) => c.request(req)));
      } catch (error) {
        const first: unknown = error instanceof AggregateError ? error.errors[0] : error;
        throw first instanceof Error ? first : new Error(String(first));
      }
      await Promise.all(channels.map((c) => c.settle(req.id, outcome).catch(() => undefined)));
      return outcome;
    },
  };
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
      if (req.title) term.out(`  Change:    ${req.title}`);
      term.out(`  ${req.preview ? 'Steps:    ' : 'Arguments:'} ${req.args}`);
      if (req.preview) {
        term.out('');
        for (const line of req.preview.split('\n')) term.out(`    ${line}`);
        term.out('');
      }
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
