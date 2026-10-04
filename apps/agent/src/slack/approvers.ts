import type { SlackUser } from './api.ts';

export interface ResolvedApprovers {
  /** Slack user ids allowed to approve. */
  ids: Set<string>;
  /** Config entries that matched nobody (no one can approve through them). */
  unresolved: string[];
}

/**
 * Slack handles are no longer unique or reliable, so approvals are checked by user id.
 * `U…`/`W…` entries are ids already; `@name` entries are matched once, at startup, against
 * a user's username or display name. An ambiguous name (two people) matches nobody.
 */
export function resolveApprovers(
  entries: readonly string[],
  users: readonly SlackUser[],
): ResolvedApprovers {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (const entry of entries) {
    if (/^[UW][A-Z0-9]{2,}$/.test(entry)) {
      ids.add(entry);
      continue;
    }
    const name = entry.replace(/^@/, '').toLowerCase();
    const matches = users.filter(
      (u) => u.name.toLowerCase() === name || u.displayName.toLowerCase() === name,
    );
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) ids.add(only.id);
    else unresolved.push(entry);
  }
  return { ids, unresolved };
}
