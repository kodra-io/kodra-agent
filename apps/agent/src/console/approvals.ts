import type { ApprovalOutcome, ApprovalRequest, SettleableChannel } from '../approvals.ts';
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
  /** A proposed change: its title and preview (a diff for file edits). */
  title?: string;
  preview?: string;
}

export type ConsoleDecision = 'approved' | 'denied' | 'refused' | 'expired' | 'unknown';

interface Pending {
  req: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Approval requests answered in the console. A decision counts only from a console
 * approver, before the request expires, and only once; a refused one is audited with who
 * tried. Accepted decisions are audited by the agent, like Slack clicks.
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

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ req }) => ({
      id: req.id,
      connector: req.connector,
      tool: req.tool,
      risk: req.risk,
      args: req.args,
      reason: req.reason,
      requestedBy: req.requestedBy,
      expiresAt: req.expiresAt.toISOString(),
      ...(req.title ? { title: req.title } : {}),
      ...(req.preview ? { preview: req.preview } : {}),
    }));
  }

  async decide(
    user: ConsoleUser,
    id: string,
    approve: boolean,
    note?: string,
  ): Promise<ConsoleDecision> {
    const entry = this.pending.get(id);
    if (!entry) return 'unknown';
    if (!user.canApprove) {
      await this.audit.append({
        event: 'approval.decision',
        actor: user.name,
        connector: entry.req.connector,
        tool: entry.req.tool,
        risk: entry.req.risk,
        decision: 'blocked',
        detail: `${id}; click refused: not an approver`,
      });
      return 'refused';
    }
    if (this.now() > entry.req.expiresAt) {
      this.finish(id, { decision: 'expired' });
      return 'expired';
    }
    const trimmed = note?.trim().slice(0, 500);
    this.finish(
      id,
      approve
        ? { decision: 'approved', by: user.name }
        : { decision: 'denied', by: user.name, ...(trimmed ? { note: trimmed } : {}) },
    );
    return approve ? 'approved' : 'denied';
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
