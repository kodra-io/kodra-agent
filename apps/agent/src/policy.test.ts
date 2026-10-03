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
      const optional: ToolGuard[] = [
        { kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: false },
      ];
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

  describe('repo-in-setting guard', () => {
    const github: ToolGuard[] = [
      { kind: 'repo-in-setting', ownerArg: 'owner', repoArg: 'repo', setting: 'repos' },
    ];
    const gitlab: ToolGuard[] = [
      { kind: 'repo-in-setting', repoArg: 'project_id', setting: 'projects' },
    ];
    const read = (guards: ToolGuard[], args: Record<string, unknown>, extra = {}) =>
      kind(
        decide({
          ...base,
          risk: 'read',
          access: 'read-only',
          guards,
          args,
          settings: { repos: ['acme/api'], projects: ['acme/platform/api'] },
          ...extra,
        }),
      );

    it('allows a configured repo, ignoring case', () => {
      expect(read(github, { owner: 'Acme', repo: 'API' })).toBe('allow');
      expect(read(gitlab, { project_id: 'acme/platform/api' })).toBe('allow');
    });

    it.each([
      [{ owner: 'acme', repo: 'other' }],
      [{ owner: 'evil', repo: 'api' }],
      [{ repo: 'api' }],
      [{ owner: 'acme' }],
      [{ owner: 'acme', repo: ['api'] }],
    ])('blocks %j', (args) => {
      expect(read(github, args)).toBe(
        'block: the repository must be one of the configured repos: acme/api',
      );
    });

    it('blocks a numeric GitLab project id, so the model must use the path', () => {
      expect(read(gitlab, { project_id: 42 })).toMatch(/^block: the repository must be one of/);
    });

    it('reads the setting from a required connector with `from`', () => {
      const fromGithub: ToolGuard[] = [
        {
          kind: 'repo-in-setting',
          ownerArg: 'owner',
          repoArg: 'repo',
          setting: 'repos',
          from: 'github',
        },
      ];
      const shared = { sharedSettings: { github: { repos: ['acme/web'] } } };
      expect(read(fromGithub, { owner: 'acme', repo: 'web' }, shared)).toBe('allow');
      // Its own settings do not count, and without the shared settings nothing is allowed.
      expect(read(fromGithub, { owner: 'acme', repo: 'api' }, shared)).toMatch(/^block/);
      expect(read(fromGithub, { owner: 'acme', repo: 'web' })).toMatch(/^block/);
    });
  });

  describe('not-default-branch guard (golden rule 6)', () => {
    const guards: ToolGuard[] = [
      { kind: 'not-default-branch', branchArg: 'branch', ownerArg: 'owner', repoArg: 'repo' },
    ];
    const write = (args: Record<string, unknown>, defaults?: Map<string, string | null>) =>
      kind(
        decide({
          ...base,
          risk: 'write',
          access: 'read-write-approved',
          guards,
          args,
          settings: {},
          ...(defaults ? { defaultBranches: defaults } : {}),
        }),
      );
    const known = new Map<string, string | null>([['acme/api', 'main']]);

    it('allows a feature branch, which then still needs approval', () => {
      expect(write({ owner: 'acme', repo: 'api', branch: 'fix/crash' }, known)).toBe('approve');
    });

    it.each(['main', 'MAIN', ' main ', 'refs/heads/main'])(
      'blocks the default branch written as %j',
      (branch) => {
        expect(write({ owner: 'acme', repo: 'api', branch }, known)).toMatch(
          /is the default branch of acme\/api/,
        );
      },
    );

    it('blocks a missing branch, which would mean the default branch', () => {
      expect(write({ owner: 'acme', repo: 'api' }, known)).toBe(
        'block: branch is required: changes never go to the default branch',
      );
      expect(write({ owner: 'acme', repo: 'api', branch: '' }, known)).toMatch(
        /^block: branch is required/,
      );
    });

    it('blocks when the default branch is unknown or its lookup failed', () => {
      expect(write({ owner: 'acme', repo: 'api', branch: 'x' })).toBe(
        'block: the default branch of acme/api is unknown, so changes to it are blocked',
      );
      const failed = new Map<string, string | null>([['acme/api', null]]);
      expect(write({ owner: 'acme', repo: 'api', branch: 'x' }, failed)).toMatch(/is unknown/);
    });

    it('treats a renamed default like any other name', () => {
      const trunk = new Map<string, string | null>([['acme/api', 'trunk']]);
      expect(write({ owner: 'acme', repo: 'api', branch: 'main' }, trunk)).toBe('approve');
      expect(write({ owner: 'acme', repo: 'api', branch: 'trunk' }, trunk)).toMatch(/^block/);
    });
  });
});
