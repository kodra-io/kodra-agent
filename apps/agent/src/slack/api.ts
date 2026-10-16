import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { EnvHttpProxyAgent } from 'undici';

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
  /** Opens a modal for the person who clicked; Slack accepts the trigger for 3 seconds only. */
  openModal(triggerId: string, view: unknown): Promise<void>;
}

export interface SlackMessage {
  text: string;
  blocks?: unknown[] | undefined;
}

export interface SlackUser {
  id: string;
  name: string;
  displayName: string;
  /** Full name, to show who a name matched. */
  realName?: string;
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
  /** For opening a modal in reply to the click. */
  triggerId?: string | undefined;
}

/** A submitted modal: its callback id, the request id it carries, and each input's value. */
export interface IncomingSubmission {
  user: string;
  callbackId: string;
  privateMetadata: string;
  values: Record<string, string>;
}

export interface SlackHandlers {
  onMention(message: IncomingMessage): Promise<void>;
  onDirectMessage(message: IncomingMessage): Promise<void>;
  onAction(action: IncomingAction): Promise<void>;
  /** Returns errors to show next to the inputs (by block id), or null to close the modal. */
  onSubmission(submission: IncomingSubmission): Promise<Record<string, string> | null>;
}

export interface SlackConnection {
  api: SlackApi;
  start(handlers: SlackHandlers): Promise<void>;
  stop(): Promise<void>;
}

/** Slack over Socket Mode with Bolt: no public endpoint, only an outbound WebSocket. */
export function boltSlack(
  botToken: string,
  appToken: string,
  proxy?: { httpsProxy?: string; httpProxy?: string; noProxy: string } | null,
): SlackConnection {
  // Web API calls use fetch, which the agent's global proxy covers. The Socket Mode WebSocket
  // has its own HTTP stack (undici), so it gets the proxy as a dispatcher (M12).
  const receiver = new SocketModeReceiver({
    appToken,
    logLevel: LogLevel.ERROR,
    ...(proxy ? { dispatcher: new EnvHttpProxyAgent(proxy) } : {}),
  });
  const app = new App({ token: botToken, receiver, logLevel: LogLevel.ERROR });
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
    async openModal(triggerId, view) {
      await app.client.views.open({ trigger_id: triggerId, view: view as never });
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
          triggerId: 'trigger_id' in body ? body.trigger_id : undefined,
        });
      });
      app.view(/^kodra_/, async ({ ack, body, view }) => {
        const values: Record<string, string> = {};
        for (const [block, inputs] of Object.entries(view.state.values)) {
          const input = Object.values(inputs)[0];
          if (input?.value) values[block] = input.value;
        }
        const errors = await handlers.onSubmission({
          user: body.user.id,
          callbackId: view.callback_id,
          privateMetadata: view.private_metadata,
          values,
        });
        await ack(errors ? { response_action: 'errors', errors } : undefined);
      });
      await app.start();
    },
    async stop() {
      await app.stop();
    },
  };
}
