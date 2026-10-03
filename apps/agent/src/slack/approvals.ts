import type { ApprovalChannel, ApprovalOutcome, ApprovalRequest } from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { Redactor } from '../redactor.ts';
import type { IncomingAction, SlackApi } from './api.ts';

export const APPROVE_ACTION = 'kodra_approve';
export const DENY_ACTION = 'kodra_deny';

interface Pending {
  req: ApprovalRequest;
  channel: string;
  ts: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface SlackApprovalsOptions {
  api: SlackApi;
  audit: AuditLog;
  redactor: Redactor;
  approverIds: ReadonlySet<string>;
  now?: () => Date;
}

/**
 * Approval requests as Slack messages with Approve and Deny buttons. A click counts only
 * from a listed approver, before the request expires, and only once. Every click,
 * accepted or refused, is audited with the Slack user id.
 */
export class SlackApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly opts: SlackApprovalsOptions;
  private readonly now: () => Date;

  constructor(opts: SlackApprovalsOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /** An approval channel that posts into a given channel and thread. */
  channelFor(channel: string, threadTs: string | undefined): ApprovalChannel {
    return { request: (req) => this.request(req, channel, threadTs) };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private async request(
    req: ApprovalRequest,
    channel: string,
    threadTs: string | undefined,
  ): Promise<ApprovalOutcome> {
    const ms = req.expiresAt.getTime() - this.now().getTime();
    if (ms <= 0) return { decision: 'expired' };
    const posted = await this.opts.api.postMessage({
      channel,
      threadTs,
      text: this.summary(req, 'needs approval'),
      blocks: this.blocks(req, null),
    });
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        void this.finish(req.id, { decision: 'expired' }, 'expired: nothing was run');
      }, ms);
      this.pending.set(req.id, { req, channel: posted.channel, ts: posted.ts, resolve, timer });
    });
  }

  /** Handles a button click. Returns what happened, for logging and tests. */
  async handleAction(
    action: IncomingAction,
  ): Promise<'approved' | 'denied' | 'refused' | 'unknown'> {
    const entry = this.pending.get(action.value);
    if (!entry) return 'unknown';
    const base = {
      actor: action.user,
      connector: entry.req.connector,
      tool: entry.req.tool,
      risk: entry.req.risk === 'unclassified' ? ('unclassified' as const) : entry.req.risk,
    };
    if (!this.opts.approverIds.has(action.user)) {
      await this.opts.audit.append({
        ...base,
        event: 'approval.decision',
        decision: 'blocked',
        detail: `${entry.req.id}; click refused: not an approver`,
      });
      return 'refused';
    }
    if (this.now() > entry.req.expiresAt) {
      await this.finish(entry.req.id, { decision: 'expired' }, 'expired: nothing was run');
      return 'refused';
    }
    const approved = action.actionId === APPROVE_ACTION;
    await this.finish(
      entry.req.id,
      approved
        ? { decision: 'approved', by: action.user }
        : { decision: 'denied', by: action.user },
      approved ? `approved by <@${action.user}>` : `denied by <@${action.user}>`,
    );
    return approved ? 'approved' : 'denied';
  }

  /** Resolves a request once, updates its message, and stops its timer. */
  private async finish(id: string, outcome: ApprovalOutcome, label: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    await this.opts.api
      .updateMessage({
        channel: entry.channel,
        ts: entry.ts,
        text: this.summary(entry.req, label),
        blocks: this.blocks(entry.req, label),
      })
      .catch(() => undefined);
  }

  /** Refuses every open request, for shutdown. */
  async cancelAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      await this.finish(id, { decision: 'expired' }, 'cancelled: the agent stopped');
    }
  }

  private summary(req: ApprovalRequest, state: string): string {
    return this.opts.redactor.redact(
      `Approval (${req.risk}) ${req.connector}/${req.tool}: ${state}`,
    );
  }

  private blocks(req: ApprovalRequest, outcome: string | null): unknown[] {
    const r = (s: string) => this.opts.redactor.redact(s);
    const blocks: unknown[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: r(`*Approval needed (${req.risk}):* \`${req.connector}\` / \`${req.tool}\``),
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: r(`*Why:*\n${req.reason}`) },
          {
            type: 'mrkdwn',
            text: `*Expires:*\n<!date^${String(Math.floor(req.expiresAt.getTime() / 1000))}^{time}|${req.expiresAt.toISOString()}>`,
          },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: r(`*Arguments:*\n\`\`\`${req.args.slice(0, 2500)}\`\`\``) },
      },
    ];
    if (outcome === null) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: APPROVE_ACTION,
            value: req.id,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: DENY_ACTION,
            value: req.id,
          },
        ],
      });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: r(`*${outcome}*`) }] });
    }
    return blocks;
  }
}
