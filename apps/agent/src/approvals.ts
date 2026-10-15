import { randomUUID } from 'node:crypto';
import { matchEnvironment, type ApprovalRules, type EffectivePolicy } from '@kodra-agent/schema';
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
  /** Who asked, as the audit log names them: `slack:U…`, a console account, `agent`, `ship`. */
  requestedBy: string;
  expiresAt: Date;
  /** The environment the change is in; null for the default policy. */
  environment: string | null;
  /** Counts the votes against the environment's rules. Every channel votes through it. */
  ballot: Ballot;
  /** A proposed change: its one-line title and the readable preview (a diff for file edits). */
  title?: string;
  preview?: string;
}

export type ApprovalOutcome =
  /** `by` names every approver, comma-separated, in the order they approved. */
  | { decision: 'approved'; by: string }
  | { decision: 'denied'; by: string; note?: string }
  | { decision: 'expired' };

/** The person at the terminal. A terminal approval always counts as the requester's own. */
export const CLI_VOTER = 'cli';

/**
 * The approver identity of whoever asked: a Slack user id, a console account, the terminal, or
 * the agent itself for alert investigations.
 */
export function requesterOf(actor: string): string {
  if (actor.startsWith('slack:')) return actor.slice('slack:'.length);
  if (actor === 'monitor') return 'agent:monitor';
  if (actor === 'agent' || actor === 'ship' || actor === CLI_VOTER) return CLI_VOTER;
  return actor;
}

export interface BallotProgress {
  approvedBy: string[];
  needed: number;
}

export type VoteResult =
  /** Counted; more approvals are still needed. */
  | { kind: 'counted'; progress: BallotProgress }
  /** The vote decided the request. */
  | { kind: 'decided'; outcome: ApprovalOutcome }
  /** Not counted, with the reason in words the voter reads. */
  | { kind: 'refused'; reason: string }
  /** Already decided. */
  | { kind: 'closed' };

const NOT_AN_APPROVER = 'You are not an approver for this change.';

/**
 * The votes on one request (PLAN-v0.2 M10). A vote counts only from an approver listed for the
 * request's environment; the requester's own approval counts only where self-approval is
 * allowed; it needs `minApprovers` different approvers, and any denial ends it.
 */
export class Ballot {
  private readonly approved: string[] = [];
  private closed = false;
  private readonly listeners = new Set<(progress: BallotProgress) => void>();
  readonly rules: ApprovalRules;
  readonly requester: string;

  constructor(rules: ApprovalRules, requester: string) {
    this.rules = rules;
    this.requester = requester;
  }

  get progress(): BallotProgress {
    return { approvedBy: [...this.approved], needed: this.rules.minApprovers };
  }

  private listed(voter: string): boolean {
    return voter === CLI_VOTER || this.rules.approvers.includes(voter);
  }

  /** Why this voter can never approve, or null when they can. */
  cannotApprove(voter: string): string | null {
    if (!this.listed(voter)) return NOT_AN_APPROVER;
    const self = voter === CLI_VOTER || voter === this.requester;
    if (self && !this.rules.allowSelfApproval) {
      return 'You asked for this change, so someone else must approve it.';
    }
    return null;
  }

  vote(voter: string, approve: boolean, note?: string): VoteResult {
    if (this.closed) return { kind: 'closed' };
    if (!this.listed(voter)) return { kind: 'refused', reason: NOT_AN_APPROVER };
    if (!approve) {
      this.close();
      return {
        kind: 'decided',
        outcome: { decision: 'denied', by: voter, ...(note ? { note } : {}) },
      };
    }
    const why = this.cannotApprove(voter);
    if (why) return { kind: 'refused', reason: why };
    if (this.approved.includes(voter)) {
      return { kind: 'refused', reason: 'You already approved this. It needs another approver.' };
    }
    this.approved.push(voter);
    if (this.approved.length >= this.rules.minApprovers) {
      this.close();
      return { kind: 'decided', outcome: { decision: 'approved', by: this.approved.join(', ') } };
    }
    const progress = this.progress;
    for (const listener of this.listeners) listener(progress);
    return { kind: 'counted', progress };
  }

  /** Called with the progress after each counted approval, so every channel can show it. */
  onProgress(listener: (progress: BallotProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

/** "1 of 2 approved", for Slack and the terminal. */
export function progressLabel(progress: BallotProgress): string {
  return `${String(progress.approvedBy.length)} of ${String(progress.needed)} approved`;
}

/** Where approvals are asked: the terminal, Slack buttons, or the console. */
export interface ApprovalChannel {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;
  /** Closes a waiting request because the turn was stopped; it resolves as expired. */
  cancel?(id: string): Promise<void>;
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
  const cancel = async (id: string) => {
    await Promise.all(
      channels.map((c) => c.settle(id, { decision: 'expired' }).catch(() => undefined)),
    );
  };
  const [only] = channels;
  if (channels.length === 1 && only) return { request: (req) => only.request(req), cancel };
  return {
    cancel,
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

/** The rules a request is checked against, and the environment they come from. */
export interface RequestRules extends ApprovalRules {
  environment: string | null;
}

/**
 * The approval rules for a call or change touching these namespaces and repos, or why it is
 * refused: one request covers one environment.
 */
export function rulesFor(
  policy: EffectivePolicy,
  touched: { namespaces: readonly string[]; repos: readonly string[] },
): { ok: true; rules: RequestRules } | { ok: false; reason: string } {
  const match = matchEnvironment(policy, touched);
  switch (match.kind) {
    case 'default':
      return { ok: true, rules: { ...match.rules, environment: null } };
    case 'environment': {
      const { name, approvers, minApprovers, allowSelfApproval, expiresAfterMinutes } =
        match.environment;
      return {
        ok: true,
        rules: {
          environment: name,
          approvers,
          minApprovers,
          allowSelfApproval,
          expiresAfterMinutes,
        },
      };
    }
    case 'conflict':
      return {
        ok: false,
        reason: `this touches ${match.names.join(' and ')}, which have different approval rules. Make one change per environment`,
      };
  }
}

export function newApprovalRequest(
  fields: Omit<ApprovalRequest, 'id' | 'expiresAt' | 'environment' | 'ballot'>,
  rules: RequestRules,
  now: Date = new Date(),
): ApprovalRequest {
  const { environment, ...approval } = rules;
  return {
    ...fields,
    id: randomUUID(),
    environment,
    ballot: new Ballot(approval, requesterOf(fields.requestedBy)),
    // The expiry covers the whole request, however many approvals it needs.
    expiresAt: new Date(now.getTime() + rules.expiresAfterMinutes * 60_000),
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
      // The terminal is the requester, so it can approve only where self-approval is allowed.
      const why = req.ballot.cannotApprove(CLI_VOTER);
      if (why) {
        term.out(`  ${why} Ask in Slack or the console instead. Nothing was run.`);
        return { decision: 'denied', by: 'policy', note: why };
      }
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
        const result = req.ballot.vote(CLI_VOTER, answer);
        if (result.kind === 'decided') return result.outcome;
        if (result.kind === 'counted') {
          term.out(
            `  ${progressLabel(result.progress)}. The rest must approve in Slack or the console. Nothing was run.`,
          );
        }
        return { decision: 'expired' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
