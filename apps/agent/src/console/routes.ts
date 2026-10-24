import { getModelProvider } from '@kodra-agent/connectors';
import type { DoctorRow } from '../commands/doctor.ts';
import type { OnboardJobs } from './onboard.ts';
import { auditHead, verifyAuditChain } from '../audit.ts';
import { modelOptions } from '../model-options.ts';
import type { CheckRunner } from '../checks/runner.ts';
import { connectorDashboard } from '../checks/setup.ts';
import type { ConnectorDashboard } from '../dashboard.ts';
import type { PolicyGate } from './policy-gate.ts';
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
import {
  Forbidden,
  NotFound,
  type ActionRoute,
  type ApiRoute,
  type StreamRoute,
} from './server.ts';

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

const DECISION_STATUS = {
  approved: 200,
  denied: 200,
  counted: 200,
  refused: 403,
  expired: 409,
  unknown: 404,
};
const DECISION_ERROR = {
  approved: undefined,
  denied: undefined,
  counted: undefined,
  refused: 'you cannot decide this request',
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
  settings?: {
    store: SettingsStore;
    restart: () => void;
    people?: People;
    gate?: PolicyGate;
    /** Every doctor check (M30b). */
    doctor?: () => Promise<DoctorRow[]>;
  },
  extra: { dashboard?: ConnectorDashboard; checks?: CheckRunner; onboard?: OnboardJobs } = {},
): ConsoleApi {
  const auditPath = runtime.config.spec.audit.path;
  const model = `${runtime.config.spec.model.provider}/${runtime.config.spec.model.name}`;
  const text = (q: URLSearchParams, key: string) => q.get(key) ?? undefined;
  const dashboard = extra.dashboard ?? connectorDashboard(runtime);
  const { checks } = extra;

  const routes: Record<string, ApiRoute> = {
    status: async () => ({
      ...status(runtime, info),
      paused: runtime.control.paused,
      budget: await runtime.budget(),
    }),
    overview: async () => ({
      ...overview(await readAudit(auditPath), await investigations.list()),
      auditHead: await auditHead(auditPath),
    }),
    connectors: () => connectorViews(runtime),
    dashboard: () => dashboard.view(),
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
    'approvals/pending': ({ user }) => pending.list(user),
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
      const text = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined);
      const { result, reason, refusal } = await pending.decide(user, id, body['approve'], {
        note: text('note'),
        changeRef: text('changeRef'),
        reason: text('reason'),
      });
      const error = reason ?? DECISION_ERROR[result];
      return {
        status: DECISION_STATUS[result],
        body: error ? { error, result, ...(refusal ? { refusal } : {}) } : { result },
      };
    },
  };
  const streams: Record<string, StreamRoute> = {};

  if (checks) {
    routes['checks'] = () => ({ latest: checks.latest, schedules: checks.schedules });
    // Read-only and free, so anyone signed in may run the checks. The digest is saved and
    // shown here; only scheduled runs post to Slack.
    actions['checks/run'] = async ({ user }) => {
      const digest = await checks.run(`run by ${user.name}`, { post: false, commit: true });
      return { status: 200, body: { latest: digest } };
    };
  }

  const { onboard } = extra;
  if (onboard) {
    // Onboarding (M30a): anyone signed in sees the repos and reports; starting a job clones
    // with the forge token and posts to Slack, so it is for approvers.
    routes['onboard'] = () => ({ repos: onboard.repos(), jobs: onboard.list() });
    routes['onboard/job'] = ({ query }) =>
      onboard.get(query.get('id') ?? '') ?? new NotFound('no such onboarding');
    const startJob =
      (kind: 'analyze' | 'pr'): ActionRoute =>
      ({ user, body }) => {
        if (!user.canApprove) {
          return { status: 403, body: { error: 'only a console approver can onboard a repo' } };
        }
        const branch = typeof body['branch'] === 'string' && body['branch'] ? body['branch'] : null;
        const started = onboard.start(
          kind,
          typeof body['repo'] === 'string' ? body['repo'] : '',
          branch,
          user.name,
        );
        return 'job' in started
          ? { status: 200, body: { id: started.job.id } }
          : { status: started.status, body: { error: started.error } };
      };
    actions['onboard/analyze'] = startJob('analyze');
    actions['onboard/pr'] = startJob('pr');
  }

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

    const { gate } = settings;
    routes['settings'] = async () => {
      const last = (await readAudit(auditPath)).filter((r) => r.event === 'settings').at(-1);
      const view = await store.view(
        last ? { by: last.actor, at: last.ts, detail: last.detail ?? '' } : null,
      );
      return { ...view, policyChanges: gate?.mode ?? 'audited', waiting: gate?.pending() ?? [] };
    };
    /** A policy change in strict waits for a second approver; 202 says it is waiting. */
    const held = (id: string) => ({ status: 202, body: { pending: id } });
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
      const base = str(body['base']);
      // A new model is tried with one tiny call first, so a typo never stops the agent.
      const modelProblem = await store.checkModelChange(patch);
      if (modelProblem) return { status: 400, body: { error: modelProblem } };
      const preview = await store.preview(patch);
      if (preview.ok && preview.diff !== '' && preview.policy && gate?.mode === 'second-approver') {
        if (preview.base !== base) {
          return { status: 409, body: { error: 'the settings changed meanwhile; review again' } };
        }
        const title = `changed ${preview.changed.join(', ')}`;
        const id = gate.hold(
          user.name,
          title,
          preview.diff,
          async () => {
            const applied = await store.apply(patch, base, user.name);
            if (applied === 'stale') return 'the settings changed after it was asked';
            return applied.ok ? null : applied.errors.join('; ');
          },
          restart,
        );
        return { status: 202, body: { ...preview, pending: id } };
      }
      const result = await store.apply(patch, base, user.name);
      if (result === 'stale') {
        return { status: 409, body: { error: 'the settings changed meanwhile; review again' } };
      }
      if (!result.ok || result.diff === '') return { status: 400, body: result };
      if (result.policy)
        await gate?.announce(user.name, `changed ${result.changed.join(', ')}`, result.diff);
      restart();
      return { status: 200, body: { ...result, restarting: true } };
    };
    actions['settings/undo'] = async ({ user }) => {
      if (!user.canApprove) return approverOnly;
      const undo = await store.undoPreview();
      if (undo?.policy && gate?.mode === 'second-approver') {
        return held(
          gate.hold(
            user.name,
            'undid the last change',
            undo.diff,
            async () => ((await store.undo(user.name)) ? null : 'there was nothing to undo'),
            restart,
          ),
        );
      }
      if (undo?.policy) await gate?.announce(user.name, 'undid the last change', undo.diff);
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
        const error = result.hint ? `${result.message}. ${result.hint}` : result.message;
        return { status: 400, body: { error, check: result } };
      }
      restart();
      return { status: 200, body: { check: result, restarting: true } };
    };
    // Trusting a CA lets it vouch for any host: approvers only, audited.
    actions['settings/ca-bundle'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const result = await store.setCaBundle(
        body['remove'] === true ? null : str(body['pem']),
        user.name,
      );
      if (!result.ok) return { status: 400, body: { error: result.message } };
      restart();
      return { status: 200, body: { certificates: result.certificates, restarting: true } };
    };
    routes['settings/models'] = async ({ user }) =>
      user.canApprove
        ? store.modelOptions(await readAudit(auditPath))
        : new Forbidden(approverOnly.body.error);
    // A paid call, however small: approvers only.
    actions['settings/model-test'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      return { status: 200, body: await store.testModel(str(body['name'])) };
    };
    routes['settings/providers'] = async ({ user }) =>
      user.canApprove ? store.providers() : new Forbidden(approverOnly.body.error);
    const candidateOf = (body: Record<string, unknown>) => {
      const strings = (v: unknown) =>
        Object.fromEntries(
          Object.entries(v && typeof v === 'object' ? v : {}).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        );
      return {
        provider: str(body['provider']),
        name: str(body['name']),
        config: strings(body['config']),
        secrets: strings(body['secrets']),
      };
    };
    // Checks a provider before switching: its checks with the key, then its models.
    actions['settings/provider-check'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const c = await store.switchCandidate(candidateOf(body));
      if (!c.ok) return { status: 400, body: { error: c.error, checks: c.checks ?? [] } };
      const records = await readAudit(auditPath);
      const manifestPrices = getModelProvider(c.model.provider)?.pricing?.models ?? {};
      return {
        status: 200,
        body: {
          checks: c.checks,
          models: modelOptions({
            provider: c.model.provider,
            current: c.model.name,
            prices: manifestPrices,
            listed: c.listed,
            records,
            month: new Date().toISOString().slice(0, 7),
          }),
        },
      };
    };
    /**
     * Switches provider: checks again, tries the model once with the new key, then writes the
     * key to .env and the config. Where data goes is a policy change: announced, or held for a
     * second approver (the key is written only once it is approved).
     */
    actions['settings/provider-switch'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const c = await store.switchCandidate(candidateOf(body));
      if (!c.ok) return { status: 400, body: { error: c.error, checks: c.checks ?? [] } };
      const tried = await store.testCandidate(c.model, c.secrets);
      if (!tried.ok) {
        return { status: 400, body: { error: `${c.model.name} did not answer: ${tried.error}` } };
      }
      // A window too small for the agent's prompt: say so, and switch only when confirmed.
      const contextWarning = await store.contextWarning(c.model);
      if (contextWarning && body['acceptSmallContext'] !== true) {
        return { status: 200, body: { saved: false, contextWarning } };
      }
      const base = str(body['base']);
      const preview = await store.preview(c.patch);
      if (!preview.ok) return { status: 400, body: preview };
      const save = async () => {
        if (c.env.size > 0) await store.writeEnv(c.env);
        return store.apply(c.patch, base, user.name);
      };
      const title = `switched the model to ${c.model.provider}/${c.model.name}`;
      if (preview.policy && gate?.mode === 'second-approver') {
        if (preview.base !== base) {
          return { status: 409, body: { error: 'the settings changed meanwhile; review again' } };
        }
        const id = gate.hold(
          user.name,
          title,
          preview.diff,
          async () => {
            const applied = await save();
            if (applied === 'stale') return 'the settings changed after it was asked';
            return applied.ok ? null : applied.errors.join('; ');
          },
          restart,
        );
        return { status: 202, body: { ...preview, pending: id } };
      }
      const result = await save();
      if (result === 'stale') {
        return { status: 409, body: { error: 'the settings changed meanwhile; review again' } };
      }
      if (!result.ok) return { status: 400, body: result };
      if (result.policy) await gate?.announce(user.name, title, result.diff);
      restart();
      return { status: 200, body: { ...result, restarting: true } };
    };
    // A connection check only reads, so anyone signed in may run it.
    actions['settings/test'] = async ({ body }) => ({
      status: 200,
      body: { results: await store.test(str(body['connector'])) },
    });
    // The proxy URLs are secrets: approvers only, like any other (M30b).
    actions['settings/proxy'] = async ({ user, body }) => {
      if (!user.canApprove) return approverOnly;
      const pick = (key: string) =>
        body[key] === null ? null : typeof body[key] === 'string' ? body[key] : undefined;
      const https = pick('https');
      const http = pick('http');
      const result = await store.setProxy(
        { ...(https !== undefined ? { https } : {}), ...(http !== undefined ? { http } : {}) },
        user.name,
      );
      if (!result.ok) return { status: 400, body: { error: result.message } };
      restart();
      return { status: 200, body: { restarting: true } };
    };
    // Health (M30b): every doctor check, and the audit chain. They read, and doctor audits.
    const { doctor } = settings;
    if (doctor) {
      actions['settings/doctor'] = async ({ user }) => {
        if (!user.canApprove) return approverOnly;
        return { status: 200, body: { rows: await doctor() } };
      };
    }
    actions['settings/audit-verify'] = async () => ({
      status: 200,
      body: await verifyAuditChain(auditPath),
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
    const gate = settings.gate;
    routes['people'] = async ({ user }) =>
      user.canApprove
        ? { ...(await people.view()), waiting: gate?.pending() ?? [] }
        : new Forbidden(approverOnly.body.error);
    /**
     * Adding or removing an approver is a policy change (M11): announced, or in strict held
     * for a second approver. A held add gets its token afterwards, with Rotate.
     */
    const policyChange = async (
      action: 'add' | 'remove',
      name: string,
      by: string,
      run: (withToken: boolean) => Promise<PeopleResult>,
    ) => {
      const who = name.startsWith('console:') ? name : `console:${name}`;
      const title =
        action === 'add' ? `added ${who} as an approver` : `removed ${who} as an approver`;
      const diff = `${action === 'add' ? '+' : '-'} approver ${who}`;
      if (gate?.mode === 'second-approver') {
        const checked = await people.check(action, name);
        if (!checked.ok) return reply(checked, false);
        const id = gate.hold(
          by,
          title,
          diff,
          async () => {
            const result = await run(false);
            return result.ok ? null : result.error;
          },
          restart,
        );
        return { status: 202, body: { pending: id } };
      }
      const result = await run(true);
      if (result.ok) await gate?.announce(by, title, diff);
      return reply(result, true);
    };
    actions['people/add'] = async ({ user, body }) =>
      user.canApprove
        ? policyChange('add', str(body['name']), user.name, (withToken) =>
            people.add(str(body['name']), user.name, withToken),
          )
        : approverOnly;
    actions['people/rotate'] = async ({ user, body }) =>
      user.canApprove
        ? reply(await people.rotate(str(body['who']), user.name), true)
        : approverOnly;
    actions['people/remove'] = async ({ user, body }) =>
      user.canApprove
        ? policyChange('remove', str(body['who']), user.name, () =>
            people.remove(str(body['who']), user.name),
          )
        : approverOnly;
    actions['people/sign-out'] = async ({ user, body }) =>
      user.canApprove ? reply(await people.signOut(str(body['id'])), false) : approverOnly;
  }

  return { routes, actions, streams };
}
