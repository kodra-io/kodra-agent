import type { Runtime } from '../runtime.ts';
import type { ConsoleApprovals } from './approvals.ts';
import type { ConsoleChat } from './chat.ts';
import type { People, PeopleResult } from './people.ts';
import type { SettingsPatch, SettingsStore } from './settings.ts';
import {
  activity,
  approvals,
  connectorViews,
  overview,
  readAudit,
  status,
  usage,
  type InvestigationLog,
} from './data.ts';
import { Forbidden, type ActionRoute, type ApiRoute, type StreamRoute } from './server.ts';

export interface ConsoleInfo {
  version: string;
  startedAt: Date;
  slack: boolean;
  monitoring: boolean;
}

export interface ConsoleApi {
  routes: Record<string, ApiRoute>;
  actions: Record<string, ActionRoute>;
  streams: Record<string, StreamRoute>;
}

const DECISION_STATUS = { approved: 200, denied: 200, refused: 403, expired: 409, unknown: 404 };
const DECISION_ERROR = {
  approved: undefined,
  denied: undefined,
  refused: 'only a console approver can decide',
  expired: 'this request expired; nothing was run',
  unknown: 'no such request, or it was already decided',
};

/** The console's API: one read route per page, chat and approval actions, and chat events. */
export function consoleApi(
  runtime: Runtime,
  info: ConsoleInfo,
  investigations: InvestigationLog,
  pending: ConsoleApprovals,
  chat: ConsoleChat | null,
  settings?: { store: SettingsStore; restart: () => void; people?: People },
): ConsoleApi {
  const auditPath = runtime.config.spec.audit.path;
  const model = `${runtime.config.spec.model.provider}/${runtime.config.spec.model.name}`;
  const text = (q: URLSearchParams, key: string) => q.get(key) ?? undefined;

  const routes: Record<string, ApiRoute> = {
    status: async () => ({
      ...status(runtime, info),
      paused: runtime.control.paused,
      budget: await runtime.budget(),
    }),
    overview: async () => overview(await readAudit(auditPath), await investigations.list()),
    connectors: () => connectorViews(runtime),
    activity: async ({ query: q }) => {
      const limit = Number(q.get('limit') ?? '100');
      return activity(await readAudit(auditPath), {
        event: text(q, 'event'),
        decision: text(q, 'decision'),
        connector: text(q, 'connector'),
        actor: text(q, 'actor'),
        q: text(q, 'q'),
        before: text(q, 'before'),
        limit: Number.isFinite(limit) ? limit : undefined,
      });
    },
    usage: async () =>
      usage(await readAudit(auditPath), model, runtime.config.spec.console.pricing),
    approvals: async () => approvals(await readAudit(auditPath)),
    'approvals/pending': () => pending.list(),
    investigations: () => investigations.list(),
  };

  const actions: Record<string, ActionRoute> = {
    // Anyone signed in may pause (it only stops changes); resuming is for an approver.
    'agent/pause': async ({ user }) => {
      await runtime.control.pause(user.name);
      return { status: 200, body: { paused: runtime.control.paused } };
    },
    'agent/resume': async ({ user }) => {
      if (!user.canApprove) {
        return { status: 403, body: { error: 'only a console approver can resume changes' } };
      }
      await runtime.control.resume(user.name);
      return { status: 200, body: { paused: null } };
    },
    'approvals/decide': async ({ user, body }) => {
      const id = typeof body['id'] === 'string' ? body['id'] : '';
      if (typeof body['approve'] !== 'boolean') {
        return { status: 400, body: { error: 'approve must be true or false' } };
      }
      const note = typeof body['note'] === 'string' ? body['note'] : undefined;
      const result = await pending.decide(user, id, body['approve'], note);
      const error = DECISION_ERROR[result];
      return {
        status: DECISION_STATUS[result],
        body: error ? { error, result } : { result },
      };
    },
  };
  const streams: Record<string, StreamRoute> = {};

  if (chat) {
    routes['chat'] = () => chat.list();
    actions['chat'] = ({ user, body }) => {
      const conversation =
        typeof body['conversation'] === 'string' ? body['conversation'] : undefined;
      if (typeof body['text'] !== 'string') {
        return { status: 400, body: { error: 'text must be a string' } };
      }
      const result = chat.send(user, conversation, body['text']);
      return result.ok
        ? { status: 200, body: { conversation: result.conversation } }
        : { status: result.status, body: { error: result.error } };
    };
    actions['chat/stop'] = ({ body }) => {
      const result = chat.stop(
        typeof body['conversation'] === 'string' ? body['conversation'] : '',
      );
      return result.ok
        ? { status: 200, body: { stopped: true } }
        : { status: result.status, body: { error: result.error } };
    };
    streams['chat/events'] = ({ query, lastEventId }, send) =>
      chat.subscribe(query.get('conversation') ?? '', lastEventId, (event) => {
        // Live text pieces have no id, so a reconnect resumes after the last kept event.
        send(event.seq === 0 ? null : event.seq, event);
      });
  }

  if (settings) {
    const { store, restart } = settings;
    const approverOnly = {
      status: 403,
      body: { error: 'only a console approver can change settings' },
    };
    const patchOf = (body: Record<string, unknown>): SettingsPatch | null =>
      body['patch'] && typeof body['patch'] === 'object' && !Array.isArray(body['patch'])
        ? body['patch']
        : null;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    routes['settings'] = async () => {
      const last = (await readAudit(auditPath)).filter((r) => r.event === 'settings').at(-1);
      return store.view(last ? { by: last.actor, at: last.ts, detail: last.detail ?? '' } : null);
    };
    actions['settings/preview'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const patch = patchOf(body);
      if (!patch) return { status: 400, body: { error: 'send a patch' } };
      return { status: 200, body: await store.preview(patch) };
    };
    actions['settings/apply'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const patch = patchOf(body);
      if (!patch) return { status: 400, body: { error: 'send a patch' } };
      const result = await store.apply(patch, str(body['base']), user.name);
      if (result === 'stale') {
        return { status: 409, body: { error: 'the settings changed meanwhile; review again' } };
      }
      if (!result.ok || result.diff === '') return { status: 400, body: result };
      restart();
      return { status: 200, body: { ...result, restarting: true } };
    };
    actions['settings/undo'] = async ({ user }) => {
      if (!user.canApprove) return approverOnly;
      if (!(await store.undo(user.name))) {
        return { status: 409, body: { error: 'there is no earlier change to undo' } };
      }
      restart();
      return { status: 200, body: { restarting: true } };
    };
    actions['settings/secret'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const result = await store.setSecret(
        str(body['connector']),
        str(body['key']),
        str(body['value']),
        user.name,
      );
      if (result.status === 'fail') {
        return { status: 400, body: { error: result.message, check: result } };
      }
      restart();
      return { status: 200, body: { check: result, restarting: true } };
    };
    // A connection check only reads, so anyone signed in may run it.
    actions['settings/test'] = async ({ body }) => ({
      status: 200,
      body: { results: await store.test(str(body['connector'])) },
    });
  }

  if (settings?.people) {
    const { people, restart } = settings;
    const approverOnly = {
      status: 403,
      body: { error: 'only a console approver can manage people' },
    };
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    // A token goes back once, in this response only: never audited, logged, or kept.
    const reply = (result: PeopleResult, restarts: boolean) => {
      if (!result.ok) return { status: result.status, body: { error: result.error } };
      if (restarts) restart();
      return {
        status: 200,
        body: { ...(result.token ? { token: result.token } : {}), restarting: restarts },
      };
    };
    routes['people'] = ({ user }) =>
      user.canApprove ? people.view() : new Forbidden(approverOnly.body.error);
    actions['people/add'] = async ({ user, body }) =>
      user.canApprove ? reply(await people.add(str(body['name']), user.name), true) : approverOnly;
    actions['people/rotate'] = async ({ user, body }) =>
      user.canApprove
        ? reply(await people.rotate(str(body['who']), user.name), true)
        : approverOnly;
    actions['people/remove'] = async ({ user, body }) =>
      user.canApprove
        ? reply(await people.remove(str(body['who']), user.name), true)
        : approverOnly;
    actions['people/sign-out'] = async ({ user, body }) =>
      user.canApprove ? reply(await people.signOut(str(body['id'])), false) : approverOnly;
  }

  return { routes, actions, streams };
}
