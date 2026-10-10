import { parseAgentConfig } from '@kodra-agent/connectors';
import { consoleApproverTokenEnv, isConsoleApprover } from '@kodra-agent/schema';
import type { SessionInfo, SessionRegistry } from './server.ts';
import type { SettingsStore } from './settings.ts';
import { CONSOLE_TOKEN_ENV, newConsoleToken } from './token.ts';

/**
 * People and tokens (M8c): an approver adds or removes console approvers, rotates sign-in
 * tokens, and signs sessions out. A new token is returned once, to the approver who asked, and
 * is never audited or logged; the agent writes it to .env and restarts to use it.
 */

export const SHARED_ACCOUNT = 'console';

export interface PersonView {
  /** `console` for the shared sign-in, else `console:<name>`. */
  who: string;
  canApprove: boolean;
  /** Whether the agent started with a token for this account. */
  tokenSet: boolean;
  envVar: string;
}

export interface PeopleView {
  editable: boolean;
  people: PersonView[];
  /** Approvers that are not console accounts (Slack users), shown for context. */
  otherApprovers: string[];
  sessions: SessionInfo[];
}

export type PeopleResult =
  { ok: true; token?: string } | { ok: false; status: number; error: string };

export class People {
  private readonly store: SettingsStore;
  private readonly sessions: SessionRegistry;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(deps: {
    store: SettingsStore;
    sessions: SessionRegistry;
    env: Readonly<Record<string, string | undefined>>;
  }) {
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.env = deps.env;
  }

  private async config() {
    const parsed = parseAgentConfig(await this.store.text());
    if (!parsed.ok) throw new Error('kodra-agent.yaml does not parse');
    return parsed.config;
  }

  async view(): Promise<PeopleView> {
    const config = await this.config();
    const approvers = config.spec.policy.approvals.approvers;
    return {
      editable: config.spec.target === 'compose',
      people: [
        {
          who: SHARED_ACCOUNT,
          canApprove: false,
          tokenSet: Boolean(this.env[CONSOLE_TOKEN_ENV]),
          envVar: CONSOLE_TOKEN_ENV,
        },
        ...approvers.filter(isConsoleApprover).map((who) => ({
          who,
          canApprove: true,
          tokenSet: Boolean(this.env[consoleApproverTokenEnv(who)]),
          envVar: consoleApproverTokenEnv(who),
        })),
      ],
      otherApprovers: approvers.filter((a) => !isConsoleApprover(a)),
      sessions: this.sessions.list(),
    };
  }

  private async editable(): Promise<PeopleResult | null> {
    const config = await this.config();
    return config.spec.target === 'compose'
      ? null
      : { ok: false, status: 409, error: "on Kubernetes, tokens live in the agent's Secret" };
  }

  /** Adds `console:<name>` as an approver with a new token. */
  async add(name: string, by: string): Promise<PeopleResult> {
    const refused = await this.editable();
    if (refused) return refused;
    const who = name.startsWith('console:') ? name : `console:${name}`;
    if (!isConsoleApprover(who)) {
      return {
        ok: false,
        status: 400,
        error: 'use lowercase letters, digits, and dashes (up to 32), like on-call',
      };
    }
    const approvers = (await this.config()).spec.policy.approvals.approvers;
    if (approvers.includes(who)) {
      return { ok: false, status: 409, error: `${who} is already an approver` };
    }
    const saved = await this.store.applyNow(
      { policy: { approvers: [...approvers, who] } },
      by,
      `added ${who} as an approver`,
    );
    if (!saved.ok) return { ok: false, status: 400, error: saved.errors.join('; ') };
    // Both are read when the agent restarts, which the caller does after this.
    const token = newConsoleToken();
    await this.store.writeEnv(new Map([[consoleApproverTokenEnv(who), token]]));
    return { ok: true, token };
  }

  /** A new token for an account; the old one stops working when the agent restarts. */
  async rotate(who: string, by: string): Promise<PeopleResult> {
    const refused = await this.editable();
    if (refused) return refused;
    const approvers = (await this.config()).spec.policy.approvals.approvers;
    let envVar: string;
    if (who === SHARED_ACCOUNT) envVar = CONSOLE_TOKEN_ENV;
    else if (isConsoleApprover(who) && approvers.includes(who)) {
      envVar = consoleApproverTokenEnv(who);
    } else return { ok: false, status: 404, error: 'no such console account' };
    const token = newConsoleToken();
    await this.store.writeEnv(new Map([[envVar, token]]));
    await this.store.audit(by, `rotated the console token for ${who}`);
    return { ok: true, token };
  }

  /** Removes a console approver and their token. The last console approver stays. */
  async remove(who: string, by: string): Promise<PeopleResult> {
    const refused = await this.editable();
    if (refused) return refused;
    const approvers = (await this.config()).spec.policy.approvals.approvers;
    if (!isConsoleApprover(who) || !approvers.includes(who)) {
      return { ok: false, status: 404, error: 'no such console approver' };
    }
    if (approvers.filter(isConsoleApprover).length === 1) {
      return {
        ok: false,
        status: 409,
        error: 'keep at least one console approver, or nobody could change settings here',
      };
    }
    const saved = await this.store.applyNow(
      { policy: { approvers: approvers.filter((a) => a !== who) } },
      by,
      `removed ${who} as an approver`,
    );
    if (!saved.ok) return { ok: false, status: 400, error: saved.errors.join('; ') };
    await this.store.writeEnv(new Map(), [consoleApproverTokenEnv(who)]);
    return { ok: true };
  }

  /** Signs one session out now. */
  async signOut(id: string): Promise<PeopleResult> {
    if (!this.sessions.list().some((s) => s.id === id)) {
      return { ok: false, status: 404, error: 'no such session' };
    }
    await this.sessions.revoke(id);
    return { ok: true };
  }
}
