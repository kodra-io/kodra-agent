import {
  progressLabel,
  REFUSALS,
  type ApprovalOutcome,
  type ApprovalRequest,
  type BallotProgress,
  type SettleableChannel,
} from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { Redactor } from '../redactor.ts';
import type { IncomingAction, IncomingSubmission, SlackApi } from './api.ts';

export const APPROVE_ACTION = 'kodra_approve';
export const DENY_ACTION = 'kodra_deny';
/** The modal that asks for a change reference or a break-glass reason before approving. */
export const APPROVE_MODAL = 'kodra_approve_modal';
const CHANGE_REF_BLOCK = 'change_ref';
const REASON_BLOCK = 'reason';

interface Pending {
  req: ApprovalRequest;
  channel: string;
  ts: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
  stopWatching: () => void;
}

export interface SlackApprovalsOptions {
  api: SlackApi;
  audit: AuditLog;
  redactor: Redactor;
  now?: () => Date;
}

/**
 * Approval requests as Slack messages with Approve and Deny buttons. Each click is a vote on
 * the request's ballot, which applies the environment's rules (who may approve, self-approval,
 * how many approvers), and only before the request expires. Every click, counted or refused,
 * is audited with the Slack user id.
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
  channelFor(channel: string, threadTs: string | undefined): SettleableChannel {
    return {
      request: (req) => this.request(req, channel, threadTs),
      settle: (id, outcome) => this.finish(id, outcome, outcomeLabel(outcome)),
    };
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
      // Approvals made in the console show here too.
      const stopWatching = req.ballot.onProgress((progress) => {
        void this.showProgress(req.id, progress);
      });
      this.pending.set(req.id, {
        req,
        channel: posted.channel,
        ts: posted.ts,
        resolve,
        timer,
        stopWatching,
      });
    });
  }

  /** Handles a button click. Returns what happened, for logging and tests. */
  async handleAction(
    action: IncomingAction,
  ): Promise<'approved' | 'denied' | 'counted' | 'refused' | 'asked' | 'unknown'> {
    const entry = this.pending.get(action.value);
    if (!entry) return 'unknown';
    const approve = action.actionId === APPROVE_ACTION;
    const { req } = entry;
    // A change reference or a break-glass reason is asked in a modal, after the usual checks.
    const needs = req.ballot.needs;
    if (approve && (needs.changeRef || needs.reason) && !req.ballot.cannotApprove(action.user)) {
      if (this.now() > req.expiresAt) return this.vote(action.user, req, approve);
      if (!action.triggerId) return 'refused';
      await this.opts.api.openModal(action.triggerId, this.modal(req));
      return 'asked';
    }
    return this.vote(action.user, req, approve);
  }

  /** A submitted approval modal: the vote with what it asked for, or errors to show in it. */
  async handleSubmission(submission: IncomingSubmission): Promise<Record<string, string> | null> {
    if (submission.callbackId !== APPROVE_MODAL) return null;
    const entry = this.pending.get(submission.privateMetadata);
    if (!entry) return null;
    const details = {
      changeRef: submission.values[CHANGE_REF_BLOCK],
      reason: submission.values[REASON_BLOCK],
    };
    const result = entry.req.ballot.refusal(submission.user);
    if (result === null) {
      const check = this.checkDetails(entry.req, details);
      if (check) return check;
    }
    await this.vote(submission.user, entry.req, true, details);
    return null;
  }

  /** Errors for the modal's inputs, so a missing or malformed value is fixed in place. */
  private checkDetails(
    req: ApprovalRequest,
    details: { changeRef?: string | undefined; reason?: string | undefined },
  ): Record<string, string> | null {
    const needs = req.ballot.needs;
    const errors: Record<string, string> = {};
    if (needs.reason && !details.reason?.trim()) errors[REASON_BLOCK] = REFUSALS['reason-missing'];
    const ref = details.changeRef?.trim() ?? '';
    const pattern = req.ballot.rules.changeRefPattern;
    if (needs.changeRef && ref === '') errors[CHANGE_REF_BLOCK] = REFUSALS['change-ref-missing'];
    else if (needs.changeRef && pattern && !new RegExp(pattern).test(ref)) {
      errors[CHANGE_REF_BLOCK] = `${REFUSALS['change-ref-format']} Expected: ${pattern}`;
    }
    return Object.keys(errors).length > 0 ? errors : null;
  }

  private async vote(
    voter: string,
    req: ApprovalRequest,
    approve: boolean,
    details: { changeRef?: string | undefined; reason?: string | undefined } = {},
  ): Promise<'approved' | 'denied' | 'counted' | 'refused' | 'unknown'> {
    const entry = this.pending.get(req.id);
    if (!entry) return 'unknown';
    const base = {
      actor: voter,
      connector: req.connector,
      tool: req.tool,
      risk: req.risk === 'unclassified' ? ('unclassified' as const) : req.risk,
    };
    if (this.now() > req.expiresAt) {
      await this.finish(req.id, { decision: 'expired' }, 'expired: nothing was run');
      return 'refused';
    }
    const result = req.ballot.vote(voter, approve, details);
    switch (result.kind) {
      case 'refused':
        await this.opts.audit.append({
          ...base,
          event: 'approval.decision',
          decision: 'blocked',
          detail: `${req.id}; click refused: ${result.reason}`,
        });
        return 'refused';
      case 'closed':
        return 'unknown';
      case 'counted':
        await this.opts.audit.append({
          ...base,
          event: 'approval.vote',
          decision: 'approved',
          detail: `${req.id}; ${progressLabel(result.progress)}`,
        });
        return 'counted';
      case 'decided':
        await this.finish(req.id, result.outcome, outcomeLabel(result.outcome));
        return result.outcome.decision === 'approved' ? 'approved' : 'denied';
    }
  }

  private modal(req: ApprovalRequest): unknown {
    const r = (s: string) => this.opts.redactor.redact(s);
    const needs = req.ballot.needs;
    const freeze = req.ballot.rules.freeze;
    const pattern = req.ballot.rules.changeRefPattern;
    const what = req.title ?? `${req.connector}/${req.tool}`;
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: r(`*Approve:* ${what}`) } },
    ];
    if (freeze) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: r(
            `*${req.environment ?? 'This environment'} is frozen* (${freeze.name}, until ${freeze.until} ${freeze.timezone}). Approving overrides the freeze, and every approver is told.`,
          ),
        },
      });
    }
    if (needs.reason) {
      blocks.push({
        type: 'input',
        block_id: REASON_BLOCK,
        label: { type: 'plain_text', text: 'Reason for overriding the freeze' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 500 },
      });
    }
    if (needs.changeRef) {
      blocks.push({
        type: 'input',
        block_id: CHANGE_REF_BLOCK,
        label: { type: 'plain_text', text: 'Change reference' },
        ...(pattern ? { hint: { type: 'plain_text', text: `Format: ${pattern}` } } : {}),
        element: { type: 'plain_text_input', action_id: 'value', max_length: 100 },
      });
    }
    return {
      type: 'modal',
      callback_id: APPROVE_MODAL,
      private_metadata: req.id,
      title: { type: 'plain_text', text: 'Approve change' },
      submit: { type: 'plain_text', text: 'Approve' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks,
    };
  }

  /** Shows "1 of 2 approved" on the message, with the buttons still there. */
  private async showProgress(id: string, progress: BallotProgress): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    const label = `${progressLabel(progress)} by ${progress.approvedBy.map(who).join(', ')}`;
    await this.opts.api
      .updateMessage({
        channel: entry.channel,
        ts: entry.ts,
        text: this.summary(entry.req, label),
        blocks: this.blocks(entry.req, null, label),
      })
      .catch(() => undefined);
  }

  /** Resolves a request once, updates its message, and stops its timer. */
  private async finish(id: string, outcome: ApprovalOutcome, label: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.stopWatching();
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
      req.title
        ? `Approval (${req.risk}) change "${req.title}": ${state}`
        : `Approval (${req.risk}) ${req.connector}/${req.tool}: ${state}`,
    );
  }

  private blocks(req: ApprovalRequest, outcome: string | null, progress?: string): unknown[] {
    const r = (s: string) => this.opts.redactor.redact(s);
    const needed = req.ballot.rules.minApprovers;
    const rules = [
      req.environment ? `Environment: *${req.environment}*` : null,
      needed > 1 ? `Needs ${String(needed)} different approvers` : null,
      req.ballot.rules.allowSelfApproval ? null : 'The requester cannot approve it',
      req.ballot.rules.requireChangeRef ? 'Needs a change reference' : null,
      req.ballot.rules.freeze
        ? `Frozen (${req.ballot.rules.freeze.name}, until ${req.ballot.rules.freeze.until} ${req.ballot.rules.freeze.timezone}): approving overrides it and needs a reason`
        : null,
    ].filter((s): s is string => s !== null);
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
    if (req.title) {
      blocks.splice(1, 0, {
        type: 'section',
        text: { type: 'mrkdwn', text: r(`*Change:* ${req.title}`) },
      });
    }
    if (req.preview) {
      // A Slack section holds 3,000 characters; the console shows the whole preview.
      const cut = req.preview.length > 2_700;
      const shown = cut ? `${req.preview.slice(0, 2_700)}\n…` : req.preview;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: r(`\`\`\`${shown}\`\`\``) } });
      if (cut) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'The preview is cut short here. The console shows all of it.',
            },
          ],
        });
      }
    }
    if (rules.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: r(rules.join(' · ')) }] });
    }
    if (outcome === null && progress) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: r(`*${progress}*`) }] });
    }
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

/** How a decision reads on the Slack message, wherever it was made. */
export function outcomeLabel(outcome: ApprovalOutcome): string {
  if (outcome.decision === 'expired') return 'expired: nothing was run';
  if (outcome.decision === 'approved') {
    const extra = [
      outcome.changeRef ? `change ${outcome.changeRef}` : null,
      outcome.override ? `freeze override: ${outcome.override}` : null,
    ].filter((s): s is string => s !== null);
    const by = `approved by ${outcome.by.split(', ').map(who).join(', ')}`;
    return extra.length > 0 ? `${by} (${extra.join('; ')})` : by;
  }
  if (outcome.by === 'policy') {
    return `${outcome.decision}: ${('note' in outcome ? outcome.note : undefined) ?? 'refused by policy'}`;
  }
  return `${outcome.decision} by ${outcome.by.split(', ').map(who).join(', ')}`;
}

/** An approver as Slack shows them: a mention for a Slack user, the name for anyone else. */
function who(voter: string): string {
  if (voter.startsWith('console:')) return `${voter} in the console`;
  if (voter === 'cli') return 'the terminal';
  return `<@${voter}>`;
}
