import type { AccessLevel, ToolGuard, ToolRisk } from '@kodra-agent/schema';

export type Risk = ToolRisk | 'unclassified';

export type Decision = { kind: 'allow' } | { kind: 'approve' } | { kind: 'block'; reason: string };

export interface PolicyInput {
  risk: Risk;
  /** The connector's access level; undefined for connectors without access levels. */
  access: AccessLevel | undefined;
  destructiveActions: 'deny' | 'require-approval';
  guards: readonly ToolGuard[];
  args: Readonly<Record<string, unknown>>;
  settings: Readonly<Record<string, unknown>>;
  /** Settings of connectors this one requires, for guards with `from`. */
  sharedSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Default branch per repo (lowercase `owner/repo` or `group/project`), looked up at
   * startup. null means the lookup failed, which blocks writes to that repo.
   */
  defaultBranches?: ReadonlyMap<string, string | null>;
}

/**
 * The single place that decides whether a tool call may run (SPEC section 8):
 * read runs; write needs approval with read-write access, else blocked; destructive is
 * blocked unless policy allows it with approval; anything unclassified is blocked.
 * Guards run first, so a read outside the allowed namespaces is still blocked.
 */
export function decide(input: PolicyInput): Decision {
  if (input.risk === 'unclassified') {
    return { kind: 'block', reason: 'this tool has no risk classification' };
  }
  for (const guard of input.guards) {
    const problem = checkGuard(guard, input);
    if (problem) return { kind: 'block', reason: problem };
  }
  switch (input.risk) {
    case 'read':
      return { kind: 'allow' };
    case 'write':
      return input.access === 'read-write-approved'
        ? { kind: 'approve' }
        : { kind: 'block', reason: 'this connector is read-only' };
    case 'destructive':
      if (input.destructiveActions !== 'require-approval') {
        return { kind: 'block', reason: 'destructive actions are denied by policy' };
      }
      return input.access === 'read-write-approved'
        ? { kind: 'approve' }
        : { kind: 'block', reason: 'this connector is read-only' };
  }
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

function listSetting(settings: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = settings[key];
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** `owner/repo` from the tool's arguments, or null when it is missing or not a string. */
function repoFrom(
  args: Readonly<Record<string, unknown>>,
  repoArg: string,
  ownerArg?: string,
): string | null {
  const repo = args[repoArg];
  if (typeof repo !== 'string' || repo === '') return null;
  if (!ownerArg) return repo;
  const owner = args[ownerArg];
  return typeof owner === 'string' && owner !== '' ? `${owner}/${repo}` : null;
}

function checkGuard(guard: ToolGuard, input: PolicyInput): string | null {
  const { args, settings } = input;
  switch (guard.kind) {
    case 'arg-in-setting': {
      const value = args[guard.arg];
      if (isBlank(value)) return guard.required ? `${guard.arg} is required` : null;
      const list = listSetting(settings, guard.setting);
      return typeof value === 'string' && list.includes(value)
        ? null
        : `${guard.arg} must be one of the configured ${guard.setting}: ${list.join(', ') || 'none'}`;
    }
    case 'repo-in-setting': {
      const repo = repoFrom(args, guard.repoArg, guard.ownerArg);
      const source = guard.from ? (input.sharedSettings?.[guard.from] ?? {}) : settings;
      const list = listSetting(source, guard.setting);
      if (repo && list.some((r) => r.toLowerCase() === repo.toLowerCase())) return null;
      return `the repository must be one of the configured ${guard.setting}: ${list.join(', ') || 'none'}`;
    }
    case 'not-default-branch': {
      // Golden rule 6: never push to a default branch. A missing branch means the default.
      const branch = args[guard.branchArg];
      if (typeof branch !== 'string' || branch.trim() === '') {
        return `${guard.branchArg} is required: changes never go to the default branch`;
      }
      const repo = repoFrom(args, guard.repoArg, guard.ownerArg);
      if (!repo) return 'the repository is required';
      const defaultBranch = input.defaultBranches?.get(repo.toLowerCase());
      if (defaultBranch === undefined || defaultBranch === null) {
        return `the default branch of ${repo} is unknown, so changes to it are blocked`;
      }
      const normalize = (b: string) =>
        b
          .trim()
          .replace(/^refs\/heads\//, '')
          .toLowerCase();
      return normalize(branch) === normalize(defaultBranch)
        ? `${branch} is the default branch of ${repo}; changes go through a pull request on another branch`
        : null;
    }
  }
}
