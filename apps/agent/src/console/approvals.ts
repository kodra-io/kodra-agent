import {
  progressLabel,
  type ApprovalOutcome,
  type Refusal,
  type ApprovalRequest,
  type SettleableChannel,
  type VoteDetails,
} from '../approvals.ts';
import type { AuditLog } from '../audit.ts';

/** Who is signed in to the console: `console` (the shared token) or `console:<name>`. */
export interface ConsoleUser {
  name: string;
  canApprove: boolean;
}

/** A request waiting for a decision, as the console shows it. Already redacted. */
export interface PendingApproval {
  id: string;
  connector: string;
  tool: string;
  risk: string;
  args: string;
  reason: string;
  requestedBy: string;
  expiresAt: string;
  /** The environment's name, or null for the default policy. */
  environment: string | null;
  /** Different approvers needed, and who has approved so far. */
  needed: number;
  approvedBy: string[];
  /** Why the signed-in person cannot approve this one, or null when they can. */
  cannotApprove: Refusal | 'not-console-approver' | null;
  /** What approving still needs: a change reference (with its pattern), a break-glass reason. */
  needs: { changeRef: boolean; reason: boolean };
  changeRefPattern: string | null;
  /** The change reference and the override reason given so far, for later approvers. */
  changeRef: string | null;
  override: string | null;
  /** The freeze this request overrides, if the environment is frozen. */
  freeze: { name: string; until: string; timezone: string } | null;
  /** A proposed change: its title and preview (a diff for file edits). */
  title?: string;
  preview?: string;
}

export type ConsoleDecision =
  | 'approved'
  | 'denied'
  /** Counted, and more approvers are needed. */
  | 'counted'
  | 'refused'
  | 'expired'
  | 'unknown';

export interface ConsoleDecisionResult {
  result: ConsoleDecision;
  /** Why a vote was refused, in words for the person who tried, and as a code to translate. */
  reason?: string;
  refusal?: Refusal | 'not-console-approver';
}

const NOT_A_CONSOLE_APPROVER = 'Only a console approver can decide.';

interface Pending {
  req: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Approval requests answered in the console. Each decision is a vote on the request's ballot
 * (the environment's approvers, self-approval, how many approvers), only before the request
 * expires; a refused one is audited with who tried and why. Final decisions are audited by
 * the agent, like Slack clicks.
 */
export class ConsoleApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly audit: AuditLog;
  private readonly now: () => Date;

  constructor(opts: { audit: AuditLog; now?: () => Date }) {
    this.audit = opts.audit;
    this.now = opts.now ?? (() => new Date());
  }

  readonly channel: SettleableChannel = {
    request: (req) => this.request(req),
    settle: (id, outcome) => {
      this.finish(id, outcome);
      return Promise.resolve();
    },
  };

  /** Waiting requests, with whether `user` can approve each one. */
  list(user?: ConsoleUser): PendingApproval[] {
    return [...this.pending.values()].map(({ req }) => {
      const progress = req.ballot.progress;
      const cannotApprove = user?.canApprove
        ? req.ballot.refusal(user.name)
        : 'not-console-approver';
      return {
        id: req.id,
        connector: req.connector,
        tool: req.tool,
        risk: req.risk,
        args: req.args,
        reason: req.reason,
        requestedBy: req.requestedBy,
        expiresAt: req.expiresAt.toISOString(),
        environment: req.environment,
        needed: progress.needed,
        approvedBy: progress.approvedBy,
        cannotApprove,
        needs: req.ballot.needs,
        changeRefPattern: req.ballot.rules.changeRefPattern,
        changeRef: req.ballot.changeRef,
        override: req.ballot.override,
        freeze: req.ballot.rules.freeze,
        ...(req.title ? { title: req.title } : {}),
        ...(req.preview ? { preview: req.preview } : {}),
      };
    });
  }

  async decide(
    user: ConsoleUser,
    id: string,
    approve: boolean,
    details: VoteDetails = {},
  ): Promise<ConsoleDecisionResult> {
    const entry = this.pending.get(id);
    if (!entry) return { result: 'unknown' };
    const base = {
      actor: user.name,
      connector: entry.req.connector,
      tool: entry.req.tool,
      risk: entry.req.risk,
    };
    const refuse = async (
      reason: string,
      refusal: Refusal | 'not-console-approver',
    ): Promise<ConsoleDecisionResult> => {
      await this.audit.append({
        ...base,
        event: 'approval.decision',
        decision: 'blocked',
        detail: `${id}; click refused: ${reason}`,
      });
      return { result: 'refused', reason, refusal };
    };
    if (!user.canApprove) return refuse(NOT_A_CONSOLE_APPROVER, 'not-console-approver');
    if (this.now() > entry.req.expiresAt) {
      this.finish(id, { decision: 'expired' });
      return { result: 'expired' };
    }
    const vote = entry.req.ballot.vote(user.name, approve, {
      ...details,
      note: details.note?.trim().slice(0, 500),
    });
    switch (vote.kind) {
      case 'refused':
        return refuse(vote.reason, vote.code);
      case 'closed':
        return { result: 'unknown' };
      case 'counted':
        await this.audit.append({
          ...base,
          event: 'approval.vote',
          decision: 'approved',
          detail: `${id}; ${progressLabel(vote.progress)}`,
        });
        return { result: 'counted' };
      case 'decided':
        this.finish(id, vote.outcome);
        return { result: vote.outcome.decision === 'approved' ? 'approved' : 'denied' };
    }
  }

  /** Refuses every open request, for shutdown. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { decision: 'expired' });
  }

  private request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const ms = req.expiresAt.getTime() - this.now().getTime();
    if (ms <= 0) return Promise.resolve({ decision: 'expired' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(req.id, { decision: 'expired' });
      }, ms);
      this.pending.set(req.id, { req, resolve, timer });
    });
  }

  private finish(id: string, outcome: ApprovalOutcome): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }
}
