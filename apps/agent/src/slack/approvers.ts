import { isConsoleApprover } from '@kodra-agent/schema';

export interface ResolvedApprovers {
  /** Slack user ids allowed to approve. */
  ids: Set<string>;
  /** `@name` entries, which nobody can approve through until `init` turns them into ids. */
  unresolved: string[];
}

/** A Slack user id: U… or W… (Enterprise Grid). */
export function isSlackUserId(entry: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(entry);
}

/**
 * Slack names can be changed by their owner, so at runtime only user ids count. `@name` entries
 * are looked up once by `init`, which writes the ids into the config; any left over match
 * nobody here.
 */
export function resolveApprovers(entries: readonly string[]): ResolvedApprovers {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (const entry of entries) {
    // Console approvers sign in to the console; they are not Slack users.
    if (isConsoleApprover(entry)) continue;
    if (isSlackUserId(entry)) ids.add(entry);
    else unresolved.push(entry);
  }
  return { ids, unresolved };
}
