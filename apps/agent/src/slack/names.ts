import { isConsoleApprover } from '@kodra-agent/schema';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { SlackUser } from './api.ts';
import { isSlackUserId } from './approvers.ts';

/** `@name` approver entries in the config, which `init` turns into Slack user ids. */
export function approverNames(entries: readonly string[]): string[] {
  return [...new Set(entries.filter((e) => !isConsoleApprover(e) && !isSlackUserId(e)))];
}

/**
 * Every Slack user, through `users.list` (needs users:read), with the bot token. Deleted users
 * and bots are left out: neither can approve.
 */
export async function listSlackUsers(
  doFetch: typeof fetch,
  token: string,
  base = 'https://slack.com',
): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const body = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
    const res = await doFetch(new URL('/api/users.list', base), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      members?: {
        id?: string;
        name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      }[];
      response_metadata?: { next_cursor?: string };
    } | null;
    if (!json?.ok) throw new Error(`Slack says ${json?.error ?? `HTTP ${String(res.status)}`}`);
    for (const m of json.members ?? []) {
      if (!m.id || m.deleted || m.is_bot) continue;
      users.push({
        id: m.id,
        name: m.name ?? '',
        displayName: m.profile?.display_name ?? '',
        realName: m.profile?.real_name ?? m.real_name ?? '',
      });
    }
    cursor = json.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return users;
}

export interface NameMatches {
  /** Each name that matched exactly one person. */
  found: Map<string, SlackUser>;
  /** Why the others did not, one line each. */
  problems: string[];
}

/** Matches `@name` entries to users by username or display name, ignoring case. */
export function matchNames(names: readonly string[], users: readonly SlackUser[]): NameMatches {
  const found = new Map<string, SlackUser>();
  const problems: string[] = [];
  for (const entry of names) {
    const name = entry.replace(/^@/, '').toLowerCase();
    const matches = users.filter(
      (u) => u.name.toLowerCase() === name || u.displayName.toLowerCase() === name,
    );
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) found.set(entry, only);
    else if (matches.length === 0)
      problems.push(`${entry} matches nobody in this Slack workspace.`);
    else {
      problems.push(
        `${entry} matches ${String(matches.length)} people (${matches.map((u) => u.id).join(', ')}). Use the right user id instead.`,
      );
    }
  }
  return { found, problems };
}

/**
 * kodra-agent.yaml with each found `@name` replaced by its user id, in the default approvers and
 * every environment's. The yaml Document API keeps comments and layout.
 */
export function replaceApproverNames(text: string, ids: ReadonlyMap<string, string>): string {
  const doc = parseDocument(text);
  const lists = [doc.getIn(['spec', 'policy', 'approvals', 'approvers'], true)];
  const envs = doc.getIn(['spec', 'environments'], true);
  if (isSeq(envs)) {
    for (const env of envs.items) {
      if (isMap(env)) lists.push(env.get('approvers', true));
    }
  }
  for (const list of lists) {
    if (!isSeq(list)) continue;
    for (const item of list.items) {
      if (isScalar(item) && typeof item.value === 'string') {
        const id = ids.get(item.value);
        if (id) item.value = id;
      }
    }
  }
  return doc.toString();
}
