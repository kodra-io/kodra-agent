import { App, LogLevel } from '@slack/bolt';

/**
 * The few Slack calls the agent makes, behind an interface so everything except this file
 * is tested against a fake. Every text passed in is already redacted by the caller.
 */
export interface SlackApi {
  postMessage(args: SlackMessage & { channel: string; threadTs?: string | undefined }): Promise<{
    channel: string;
    ts: string;
  }>;
  updateMessage(args: SlackMessage & { channel: string; ts: string }): Promise<void>;
  listUsers(): Promise<SlackUser[]>;
}

export interface SlackMessage {
  text: string;
  blocks?: unknown[] | undefined;
}

export interface SlackUser {
  id: string;
  name: string;
  displayName: string;
}

export interface IncomingMessage {
  user: string;
  channel: string;
  text: string;
  ts: string;
  threadTs?: string | undefined;
  /** 'im' for direct messages. */
  channelType?: string | undefined;
}

export interface IncomingAction {
  user: string;
  actionId: string;
  value: string;
}

export interface SlackHandlers {
  onMention(message: IncomingMessage): Promise<void>;
  onDirectMessage(message: IncomingMessage): Promise<void>;
  onAction(action: IncomingAction): Promise<void>;
}

export interface SlackConnection {
  api: SlackApi;
  start(handlers: SlackHandlers): Promise<void>;
  stop(): Promise<void>;
}

/** Slack over Socket Mode with Bolt: no public endpoint, only an outbound WebSocket. */
export function boltSlack(botToken: string, appToken: string): SlackConnection {
  const app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.ERROR });
  const api: SlackApi = {
    async postMessage({ channel, text, blocks, threadTs }) {
      const res = await app.client.chat.postMessage({
        channel,
        text,
        ...(blocks ? { blocks: blocks as never } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return { channel: res.channel ?? channel, ts: res.ts ?? '' };
    },
    async updateMessage({ channel, ts, text, blocks }) {
      await app.client.chat.update({
        channel,
        ts,
        text,
        ...(blocks ? { blocks: blocks as never } : {}),
      });
    },
    async listUsers() {
      const users: SlackUser[] = [];
      let cursor: string | undefined;
      do {
        const res = await app.client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
        for (const m of res.members ?? []) {
          if (!m.id) continue;
          users.push({ id: m.id, name: m.name ?? '', displayName: m.profile?.display_name ?? '' });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return users;
    },
  };
  return {
    api,
    async start(handlers) {
      app.event('app_mention', async ({ event }) => {
        await handlers.onMention({
          user: event.user ?? '',
          channel: event.channel,
          text: event.text,
          ts: event.ts,
          threadTs: event.thread_ts,
        });
      });
      app.event('message', async ({ event }) => {
        // Direct messages from people only; skip edits, bot messages, and channel chatter.
        const e = event as unknown as Record<string, unknown>;
        if (e['channel_type'] !== 'im' || e['subtype'] !== undefined || e['bot_id'] !== undefined)
          return;
        const str = (key: string) => (typeof e[key] === 'string' ? e[key] : '');
        await handlers.onDirectMessage({
          user: str('user'),
          channel: str('channel'),
          text: str('text'),
          ts: str('ts'),
          threadTs: str('thread_ts') || undefined,
          channelType: 'im',
        });
      });
      app.action(/^kodra_(approve|deny)$/, async ({ ack, body, action }) => {
        await ack();
        if (action.type !== 'button' || !('action_id' in action)) return;
        await handlers.onAction({
          user: body.user.id,
          actionId: action.action_id,
          value: action.value ?? '',
        });
      });
      await app.start();
    },
    async stop() {
      await app.stop();
    },
  };
}
