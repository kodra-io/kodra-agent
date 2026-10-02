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
    const problem = checkGuard(guard, input.args, input.settings);
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

function checkGuard(
  guard: ToolGuard,
  args: Readonly<Record<string, unknown>>,
  settings: Readonly<Record<string, unknown>>,
): string | null {
  // The only guard kind so far; M4b adds a default-branch guard for GitHub and GitLab.
  const value = args[guard.arg];
  if (value === undefined || value === null || value === '') {
    return guard.required ? `${guard.arg} is required` : null;
  }
  const allowed = settings[guard.setting];
  const list = Array.isArray(allowed) ? allowed.map((v) => String(v)) : [];
  return typeof value === 'string' && list.includes(value)
    ? null
    : `${guard.arg} must be one of the configured ${guard.setting}: ${list.join(', ') || 'none'}`;
}
