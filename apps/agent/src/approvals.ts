import { randomUUID } from 'node:crypto';
import {
  activeFreeze,
  matchEnvironment,
  type ActiveFreeze,
  type ApprovalRules,
  type EffectivePolicy,
} from '@kodra-agent/schema';
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
  /**
   * `by` names every approver, comma-separated, in the order they approved. A change
   * reference and a break-glass reason come with it where the rules asked for them.
   */
  | { decision: 'approved'; by: string; changeRef?: string; override?: string }
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
  | { kind: 'refused'; code: Refusal; reason: string }
  /** Already decided. */
  | { kind: 'closed' };

/** Why a vote cannot count, as a code the console translates and in English for the rest. */
export type Refusal =
  | 'not-listed'
  | 'self'
  | 'already-approved'
  | 'change-ref-missing'
  | 'change-ref-format'
  | 'reason-missing';
export const REFUSALS: Record<Refusal, string> = {
  'not-listed': 'You are not an approver for this change.',
  self: 'You asked for this change, so someone else must approve it.',
  'already-approved': 'You already approved this. It needs another approver.',
  'change-ref-missing': 'Approving this needs a change reference.',
  'change-ref-format': 'The change reference does not have the required format.',
  'reason-missing': 'This environment is frozen. Approving needs a reason for the override.',
};

/** What an approver gives with a vote: a denial note, a change reference, a break-glass reason. */
export interface VoteDetails {
  note?: string | undefined;
  changeRef?: string | undefined;
  reason?: string | undefined;
}

/** The rules a ballot applies: the environment's, plus the freeze in effect when it was asked. */
export interface BallotRules extends ApprovalRules {
  freeze: ActiveFreeze | null;
}

/**
 * The votes on one request (PLAN-v0.2 M10 and M11). A vote counts only from an approver listed
 * for the request's environment; the requester's own approval counts only where self-approval
 * is allowed; it needs `minApprovers` different approvers, and any denial ends it. Where the
 * rules ask for a change reference, or the environment is frozen (break-glass), the first
 * approval must give it; later approvers see it and confirm.
 */
export class Ballot {
  private readonly approved: string[] = [];
  private closed = false;
  private readonly listeners = new Set<(progress: BallotProgress) => void>();
  private ref: string | null = null;
  private overrideReason: string | null = null;
  readonly rules: BallotRules;
  readonly requester: string;

  constructor(rules: BallotRules, requester: string) {
    this.rules = rules;
    this.requester = requester;
  }

  /** The change reference given so far, if any. */
  get changeRef(): string | null {
    return this.ref;
  }

  /** The break-glass reason given so far, if any. */
  get override(): string | null {
    return this.overrideReason;
  }

  /** What the next approval still has to give. */
  get needs(): { changeRef: boolean; reason: boolean } {
    return {
      changeRef: this.rules.requireChangeRef && this.ref === null,
      reason: this.rules.freeze !== null && this.overrideReason === null,
    };
  }

  /** Why a change reference cannot be used, or null when it can. */
  private refProblem(ref: string): Refusal | null {
    if (ref === '') return 'change-ref-missing';
    const pattern = this.rules.changeRefPattern;
    return pattern && !new RegExp(pattern).test(ref) ? 'change-ref-format' : null;
  }

  get progress(): BallotProgress {
    return { approvedBy: [...this.approved], needed: this.rules.minApprovers };
  }

  private listed(voter: string): boolean {
    return voter === CLI_VOTER || this.rules.approvers.includes(voter);
  }

  /** Why this voter cannot approve now, or null when they can. */
  refusal(voter: string): Refusal | null {
    if (!this.listed(voter)) return 'not-listed';
    const self = voter === CLI_VOTER || voter === this.requester;
    if (self && !this.rules.allowSelfApproval) return 'self';
    if (this.approved.includes(voter)) return 'already-approved';
    return null;
  }

  /** The refusal in English, for Slack and the terminal. */
  cannotApprove(voter: string): string | null {
    const code = this.refusal(voter);
    return code ? REFUSALS[code] : null;
  }

  vote(voter: string, approve: boolean, details: VoteDetails = {}): VoteResult {
    if (this.closed) return { kind: 'closed' };
    const refuse = (code: Refusal): VoteResult => ({
      kind: 'refused',
      code,
      reason: REFUSALS[code],
    });
    if (!this.listed(voter)) return refuse('not-listed');
    if (!approve) {
      this.close();
      const note = details.note?.trim();
      return {
        kind: 'decided',
        outcome: { decision: 'denied', by: voter, ...(note ? { note } : {}) },
      };
    }
    const code = this.refusal(voter);
    if (code) return refuse(code);
    const needs = this.needs;
    const ref = details.changeRef?.trim().slice(0, 100) ?? '';
    if (needs.changeRef) {
      const problem = this.refProblem(ref);
      if (problem) return refuse(problem);
    }
    const reason = details.reason?.trim().slice(0, 500) ?? '';
    if (needs.reason && reason === '') return refuse('reason-missing');
    if (needs.changeRef) this.ref = ref;
    if (needs.reason) this.overrideReason = reason;
    this.approved.push(voter);
    if (this.approved.length >= this.rules.minApprovers) {
      this.close();
      return {
        kind: 'decided',
        outcome: {
          decision: 'approved',
          by: this.approved.join(', '),
          ...(this.ref ? { changeRef: this.ref } : {}),
          ...(this.overrideReason ? { override: this.overrideReason } : {}),
        },
      };
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
export interface RequestRules extends BallotRules {
  environment: string | null;
}

/**
 * The approval rules for a call or change touching these namespaces and repos, or why it is
 * refused: one request covers one environment. During one of the environment's freezes the
 * request is a break-glass override: it needs a reason, and in strict two approvers.
 */
export function rulesFor(
  policy: EffectivePolicy,
  touched: { namespaces: readonly string[]; repos: readonly string[] },
  now: Date = new Date(),
): { ok: true; rules: RequestRules } | { ok: false; reason: string } {
  const match = matchEnvironment(policy, touched);
  switch (match.kind) {
    case 'default':
      return { ok: true, rules: { ...match.rules, environment: null, freeze: null } };
    case 'environment': {
      const env = match.environment;
      const freeze = activeFreeze(env.freezes, now);
      const minApprovers =
        freeze && policy.profile === 'strict' ? Math.max(2, env.minApprovers) : env.minApprovers;
      return {
        ok: true,
        rules: {
          environment: env.name,
          approvers: env.approvers,
          minApprovers,
          allowSelfApproval: env.allowSelfApproval,
          expiresAfterMinutes: env.expiresAfterMinutes,
          requireChangeRef: env.requireChangeRef,
          changeRefPattern: env.changeRefPattern,
          freeze,
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
 * The audit fields for a decision: who decided (every approver), the change reference, and a
 * break-glass reason, so the record shows exactly what was agreed.
 */
export function decisionAudit(
  req: ApprovalRequest,
  outcome: ApprovalOutcome,
  requester: string,
  note: string | undefined,
): { actor: string; decision: ApprovalOutcome['decision']; detail: string; changeRef?: string } {
  const freeze = req.ballot.rules.freeze;
  const override =
    outcome.decision === 'approved' && outcome.override && freeze
      ? `break-glass during ${freeze.name}: ${outcome.override}`
      : undefined;
  return {
    actor: outcome.decision === 'expired' ? requester : outcome.by,
    decision: outcome.decision,
    detail: [req.id, note, override].filter((s): s is string => Boolean(s)).join('; '),
    ...(outcome.decision === 'approved' && outcome.changeRef
      ? { changeRef: outcome.changeRef }
      : {}),
  };
}

/** What all approvers are told when a change overrode a freeze, or null when none did. */
export function overrideNotice(req: ApprovalRequest, outcome: ApprovalOutcome): string | null {
  const freeze = req.ballot.rules.freeze;
  if (outcome.decision !== 'approved' || !freeze || !outcome.override) return null;
  const what = req.title ?? `${req.connector}/${req.tool}`;
  return (
    `Freeze override in ${req.environment ?? 'the default policy'}: ${outcome.by} approved "${what}" ` +
    `during ${freeze.name} (until ${freeze.until} ${freeze.timezone}). Reason: ${outcome.override}`
  );
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
        const freeze = req.ballot.rules.freeze;
        if (freeze) {
          term.out(
            `  ${req.environment ?? 'This environment'} is frozen (${freeze.name}, until ${freeze.until} ${freeze.timezone}). Approving overrides the freeze.`,
          );
        }
        const answer = await Promise.race([
          prompter.confirm('Approve this action?', false),
          timeout,
        ]);
        if (answer === 'expired' || now() > req.expiresAt) {
          term.out('  The request expired. Nothing was run.');
          return { decision: 'expired' };
        }
        const details: VoteDetails = {};
        if (answer && req.ballot.needs.reason) {
          details.reason = await prompter.text('Reason for overriding the freeze:');
        }
        if (answer && req.ballot.needs.changeRef) {
          const pattern = req.ballot.rules.changeRefPattern;
          details.changeRef = await prompter.text(
            `Change reference${pattern ? ` (format ${pattern})` : ''}:`,
          );
        }
        if (now() > req.expiresAt) {
          term.out('  The request expired. Nothing was run.');
          return { decision: 'expired' };
        }
        const result = req.ballot.vote(CLI_VOTER, answer, details);
        if (result.kind === 'refused') {
          term.out(`  ${result.reason} Nothing was run.`);
          return { decision: 'denied', by: 'policy', note: result.reason };
        }
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
