import type { AccessLevel, ToolGuard } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { decide, type Decision, type Risk } from './policy.ts';

const base = {
  destructiveActions: 'deny' as const,
  guards: [] as ToolGuard[],
  args: {},
  settings: {},
};

const kind = (d: Decision) => (d.kind === 'block' ? `block: ${d.reason}` : d.kind);

describe('policy engine', () => {
  // SPEC section 8: read runs; write needs approval with read-write access, else blocked;
  // destructive is blocked unless policy allows it and it is approved; unclassified blocked.
  it.each<[Risk, AccessLevel | undefined, 'deny' | 'require-approval', string]>([
    ['read', 'read-only', 'deny', 'allow'],
    ['read', 'read-write-approved', 'deny', 'allow'],
    ['read', undefined, 'deny', 'allow'],
    ['write', 'read-only', 'deny', 'block: this connector is read-only'],
    ['write', 'read-write-approved', 'deny', 'approve'],
    ['write', undefined, 'deny', 'block: this connector is read-only'],
    [
      'destructive',
      'read-write-approved',
      'deny',
      'block: destructive actions are denied by policy',
    ],
    ['destructive', 'read-only', 'deny', 'block: destructive actions are denied by policy'],
    ['destructive', 'read-only', 'require-approval', 'block: this connector is read-only'],
    ['destructive', 'read-write-approved', 'require-approval', 'approve'],
    [
      'unclassified',
      'read-write-approved',
      'require-approval',
      'block: this tool has no risk classification',
    ],
  ])('%s with %s access and destructive=%s -> %s', (risk, access, destructiveActions, expected) => {
    expect(kind(decide({ ...base, risk, access, destructiveActions }))).toBe(expected);
  });

  describe('arg-in-setting guard', () => {
    const guards: ToolGuard[] = [
      { kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: true },
    ];
    const settings = { namespaces: ['api', 'web'] };

    it('allows a value from the setting', () => {
      expect(
        kind(
          decide({
            ...base,
            risk: 'read',
            access: 'read-only',
            guards,
            settings,
            args: { namespace: 'api' },
          }),
        ),
      ).toBe('allow');
    });

    it('blocks a value outside the setting, even for reads', () => {
      expect(
        kind(
          decide({
            ...base,
            risk: 'read',
            access: 'read-only',
            guards,
            settings,
            args: { namespace: 'kube-system' },
          }),
        ),
      ).toBe('block: namespace must be one of the configured namespaces: api, web');
    });

    it('blocks a missing required argument', () => {
      expect(
        kind(decide({ ...base, risk: 'read', access: 'read-only', guards, settings, args: {} })),
      ).toBe('block: namespace is required');
    });

    it('blocks non-string values', () => {
      expect(
        kind(
          decide({
            ...base,
            risk: 'read',
            access: 'read-only',
            guards,
            settings,
            args: { namespace: ['api'] },
          }),
        ),
      ).toMatch(/^block: namespace must be one of/);
    });

    it('lets an optional argument be absent', () => {
      const optional: ToolGuard[] = [{ ...guards[0]!, required: false }]; // eslint-disable-line @typescript-eslint/no-non-null-assertion
      expect(
        kind(
          decide({
            ...base,
            risk: 'read',
            access: 'read-only',
            guards: optional,
            settings,
            args: {},
          }),
        ),
      ).toBe('allow');
    });

    it('runs guards before approvals, so a bad write is blocked, not approved', () => {
      expect(
        kind(
          decide({
            ...base,
            risk: 'write',
            access: 'read-write-approved',
            guards,
            settings,
            args: { namespace: 'prod' },
          }),
        ),
      ).toMatch(/^block: namespace must be one of/);
    });
  });
});
