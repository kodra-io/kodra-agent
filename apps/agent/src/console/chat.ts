import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { runTurn, type AgentDeps, type TurnEvent, type TurnUsage } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import type { Redactor } from '../redactor.ts';
import type { ConsoleUser } from './approvals.ts';

export const MAX_MESSAGE_CHARS = 8_000;

/** One step of a console conversation. Everything in it is redacted. */
export type ChatEvent = { seq: number; ts: string } & (
  | { type: 'user'; text: string; by: string }
  | { type: 'status'; state: 'queued' | 'working' | 'idle' }
  | { type: 'answer'; text: string; usage: TurnUsage; stoppedBy?: string }
  | { type: 'error'; message: string }
  | TurnEvent
);

/** Distributive Omit, so each event shape keeps its own fields. */
type NewEvent = ChatEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'seq' | 'ts'>
    : never
  : never;

export interface ConversationSummary {
  id: string;
  title: string;
  startedBy: string;
  createdAt: string;
  busy: boolean;
}

interface Conversation extends ConversationSummary {
  history: ModelMessage[];
  events: ChatEvent[];
  listeners: Set<(event: ChatEvent) => void>;
}

export interface ConsoleChatOptions {
  /** Agent dependencies for one turn, with a given approval channel. */
  deps: (approvals: ApprovalChannel) => AgentDeps;
  /** Where a console turn asks for approval (the console, and Slack if configured). */
  approvals: ApprovalChannel;
  redactor: Redactor;
  maxConversations?: number;
  /** Turns running at once across the console, to protect the model budget. */
  maxConcurrent?: number;
  maxMessagesPerMinute?: number;
  now?: () => Date;
}

export type SendResult =
  { ok: true; conversation: string } | { ok: false; status: number; error: string };

const MAX_EVENTS = 1_000;

/**
 * Conversations with the agent in the console. Kept in memory (the audit log is the
 * record). A conversation runs one turn at a time; at most `maxConcurrent` turns run at once
 * across the console. Messages from the browser are untrusted input: redacted, length- and
 * rate-limited, and they never bypass the policy.
 */
export class ConsoleChat {
  private readonly conversations = new Map<string, Conversation>();
  private readonly running = new Set<Promise<void>>();
  private readonly sent = new Map<string, number[]>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private readonly opts: ConsoleChatOptions;
  private readonly now: () => Date;

  constructor(opts: ConsoleChatOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .map(({ id, title, startedBy, createdAt, busy }) => ({
        id,
        title,
        startedBy,
        createdAt,
        busy,
      }))
      .reverse();
  }

  /** Replays events after `after`, then streams new ones. Returns the unsubscribe, or null. */
  subscribe(id: string, after: number, listener: (event: ChatEvent) => void): (() => void) | null {
    const c = this.conversations.get(id);
    if (!c) return null;
    for (const event of c.events) if (event.seq > after) listener(event);
    c.listeners.add(listener);
    return () => c.listeners.delete(listener);
  }

  send(user: ConsoleUser, conversationId: string | undefined, input: string): SendResult {
    const text = input.trim();
    if (!text) return { ok: false, status: 400, error: 'the message is empty' };
    if (text.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        status: 400,
        error: `messages are at most ${String(MAX_MESSAGE_CHARS)} characters`,
      };
    }
    const nowMs = this.now().getTime();
    const recent = (this.sent.get(user.name) ?? []).filter((t) => t > nowMs - 60_000);
    if (recent.length >= (this.opts.maxMessagesPerMinute ?? 10)) {
      return { ok: false, status: 429, error: 'too many messages, wait a minute' };
    }

    let c: Conversation | undefined;
    if (conversationId) {
      c = this.conversations.get(conversationId);
      if (!c) return { ok: false, status: 404, error: 'no such conversation' };
      if (c.busy)
        return { ok: false, status: 409, error: 'wait for the answer to the last message' };
    } else {
      const created = this.create(user, text);
      if (!created)
        return { ok: false, status: 503, error: 'every conversation is busy, try again soon' };
      c = created;
    }
    this.sent.set(user.name, [...recent, nowMs]);

    const conversation = c;
    conversation.busy = true;
    this.push(conversation, { type: 'user', text: this.opts.redactor.redact(text), by: user.name });
    const turn = this.turn(conversation, user, text).finally(() => {
      this.running.delete(turn);
    });
    this.running.add(turn);
    return { ok: true, conversation: conversation.id };
  }

  /** Waits for every running turn, for shutdown and tests. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private create(user: ConsoleUser, text: string): Conversation | null {
    const max = this.opts.maxConversations ?? 20;
    if (this.conversations.size >= max) {
      const oldest = [...this.conversations.values()].find((x) => !x.busy);
      if (!oldest) return null;
      this.conversations.delete(oldest.id);
    }
    const title = this.opts.redactor.redact(text).replace(/\s+/g, ' ').slice(0, 80);
    const c: Conversation = {
      id: randomUUID(),
      title,
      startedBy: user.name,
      createdAt: this.now().toISOString(),
      busy: false,
      history: [],
      events: [],
      listeners: new Set(),
    };
    this.conversations.set(c.id, c);
    return c;
  }

  private async turn(c: Conversation, user: ConsoleUser, text: string): Promise<void> {
    if (this.active < (this.opts.maxConcurrent ?? 2)) {
      this.active += 1;
    } else {
      // A finishing turn hands its slot straight to the next waiting one.
      this.push(c, { type: 'status', state: 'queued' });
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.push(c, { type: 'status', state: 'working' });
    try {
      const deps: AgentDeps = {
        ...this.opts.deps(this.opts.approvals),
        actor: user.name,
        events: (event) => {
          this.push(c, event);
        },
      };
      const result = await runTurn(deps, c.history, text, `console-${randomUUID().slice(0, 8)}`);
      c.history = result.messages;
      this.push(c, {
        type: 'answer',
        text: result.text,
        usage: result.usage,
        ...(result.stoppedBy ? { stoppedBy: result.stoppedBy } : {}),
      });
    } catch (error) {
      // runTurn's errors are already redacted.
      const message = error instanceof Error ? error.message : String(error);
      this.push(c, { type: 'error', message: this.opts.redactor.redact(message) });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
      c.busy = false;
      this.push(c, { type: 'status', state: 'idle' });
    }
  }

  private push(c: Conversation, event: NewEvent): void {
    const last = c.events.at(-1)?.seq ?? 0;
    const full: ChatEvent = { ...event, seq: last + 1, ts: this.now().toISOString() };
    c.events.push(full);
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS);
    for (const listener of c.listeners) listener(full);
  }
}
