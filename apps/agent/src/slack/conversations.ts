import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { runTurn, type AgentDeps } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import type { Redactor } from '../redactor.ts';
import type { IncomingMessage, SlackApi } from './api.ts';
import type { SlackApprovals } from './approvals.ts';

export interface ConversationsOptions {
  api: SlackApi;
  approvals: SlackApprovals;
  redactor: Redactor;
  /** The configured channel's id, learned from the hello message. */
  channelId: string;
  approverIds: ReadonlySet<string>;
  /** Builds agent dependencies for one turn with a given approval channel. */
  deps: (approvals: ApprovalChannel) => AgentDeps;
  maxThreads?: number;
}

/**
 * Talks with people in Slack: mentions in the configured channel, and direct messages from
 * approvers. Each thread has its own history; turns in one thread run one at a time.
 * Messages from Slack are untrusted input: redacted, and they never bypass the policy.
 */
export class SlackConversations {
  private readonly histories = new Map<string, ModelMessage[]>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly opts: ConversationsOptions;

  constructor(opts: ConversationsOptions) {
    this.opts = opts;
  }

  async onMention(message: IncomingMessage): Promise<void> {
    if (message.channel !== this.opts.channelId) return;
    await this.enqueue(message);
  }

  async onDirectMessage(message: IncomingMessage): Promise<void> {
    if (!this.opts.approverIds.has(message.user)) {
      await this.opts.api.postMessage({
        channel: message.channel,
        threadTs: message.ts,
        text: 'I only take direct messages from the approvers in my configuration. Mention me in the team channel instead.',
      });
      return;
    }
    await this.enqueue(message);
  }

  /** Waits for every running turn, for shutdown and tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private enqueue(message: IncomingMessage): Promise<void> {
    const thread = message.threadTs ?? message.ts;
    const key = `${message.channel}:${thread}`;
    const next = (this.queues.get(key) ?? Promise.resolve()).then(() =>
      this.turn(message, thread, key),
    );
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  private async turn(message: IncomingMessage, thread: string, key: string): Promise<void> {
    const text = message.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return;
    const deps = {
      ...this.opts.deps(this.opts.approvals.channelFor(message.channel, thread)),
      actor: `slack:${message.user}`,
    };
    let reply: string;
    try {
      const result = await runTurn(
        deps,
        this.histories.get(key) ?? [],
        text,
        `slack-${randomUUID().slice(0, 8)}`,
      );
      this.remember(key, result.messages);
      reply = result.text || '(no answer)';
    } catch (error) {
      reply = `Something went wrong: ${error instanceof Error ? error.message : 'the request failed'}`;
    }
    await this.opts.api.postMessage({
      channel: message.channel,
      threadTs: thread,
      text: this.opts.redactor.redact(reply).slice(0, 39_000),
    });
  }

  private remember(key: string, messages: ModelMessage[]): void {
    this.histories.delete(key);
    this.histories.set(key, messages);
    const max = this.opts.maxThreads ?? 50;
    while (this.histories.size > max) {
      const oldest = this.histories.keys().next().value;
      if (oldest === undefined) break;
      this.histories.delete(oldest);
    }
  }
}
