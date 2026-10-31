import type { AccessLevel, ToolGuard } from '@kodra-agent/schema';
import { getConnector } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { decide, describeGuards, inList, touchedBy, type Decision, type Risk } from './policy.ts';

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

describe('describeGuards', () => {
  it('states each guard as a limit the model can follow', () => {
    const guards: ToolGuard[] = [
      { kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: true },
      {
        kind: 'repo-in-setting',
        ownerArg: 'owner',
        repoArg: 'repo',
        setting: 'repos',
        from: 'github',
      },
      { kind: 'not-default-branch', branchArg: 'branch', ownerArg: 'owner', repoArg: 'repo' },
    ];
    expect(
      describeGuards(guards, { namespaces: ['dev', 'web'] }, { github: { repos: ['acme/api'] } }),
    ).toEqual([
      'namespace is required and must be one of: dev, web',
      'owner/repo must be one of: acme/api',
      'branch must be a new branch, never the default branch',
    ]);
    expect(describeGuards([guards[0] as ToolGuard], {})).toEqual([
      'namespace is required and must be one of: none configured',
    ]);
  });
});

describe('touchedBy', () => {
  const guards: ToolGuard[] = [
    {
      kind: 'arg-in-setting',
      arg: 'namespace',
      setting: 'namespaces',
      required: true,
      scope: 'namespace',
    },
    { kind: 'arg-in-setting', arg: 'kind', setting: 'kinds', required: false },
    { kind: 'repo-in-setting', ownerArg: 'owner', repoArg: 'repo', setting: 'repos' },
    { kind: 'not-default-branch', branchArg: 'branch', ownerArg: 'owner', repoArg: 'repo' },
  ];

  it('reads the namespace and repo a call touches from its guards', () => {
    expect(
      touchedBy(guards, {
        namespace: 'shop',
        kind: 'Pod',
        owner: 'acme',
        repo: 'api',
        branch: 'x',
      }),
    ).toEqual({ namespaces: ['shop'], repos: ['acme/api'] });
  });

  it('touches nothing when the arguments are missing', () => {
    expect(touchedBy(guards, {})).toEqual({ namespaces: [], repos: [] });
  });
});

describe('arg-in-setting with prefix (Jenkins jobs and folders)', () => {
  const guards: ToolGuard[] = [
    { kind: 'arg-in-setting', arg: 'fullname', setting: 'jobs', required: true, prefix: true },
  ];
  const settings = { jobs: ['team-a', 'deploy-web'] };
  const read = (fullname: string) =>
    decide({
      risk: 'read',
      access: 'read-only',
      destructiveActions: 'deny',
      guards,
      settings,
      args: { fullname },
    }).kind;

  it('allows a listed job and anything under a listed folder', () => {
    expect(read('deploy-web')).toBe('allow');
    expect(read('team-a')).toBe('allow');
    expect(read('team-a/api/main')).toBe('allow');
  });

  it('refuses other jobs, look-alikes, and paths that step outside a folder', () => {
    for (const fullname of [
      'deploy-web-2',
      'team-ab/api',
      'team-b/api',
      'team-a/../team-b',
      'team-a/./x',
      'team-a//x',
      'team-a%2F..%2Fteam-b',
      'team-a\\..\\team-b',
    ]) {
      expect(read(fullname), fullname).toBe('block');
    }
    expect(inList('deploy-web/x', ['deploy-web'], false)).toBe(false);
  });
});

describe("GitLab's built-in server guards (B4)", () => {
  const gitlab = getConnector('gitlab');
  if (!gitlab) throw new Error('gitlab');
  const guards = (tool: string) => gitlab.guards?.[tool] ?? [];
  const settings = { projects: ['acme/api'] };
  const defaultBranches = new Map([['acme/api', 'main']]);
  const call = (tool: string, args: Record<string, unknown>) =>
    kind(
      decide({
        ...base,
        risk: gitlab.tools[tool] ?? 'unclassified',
        access: 'read-write-approved',
        guards: guards(tool),
        args,
        settings,
        defaultBranches,
      }),
    );

  it('refuses a url or a group, which would name another project past the allowlist', () => {
    expect(
      call('get_repository_file', { project_id: 'acme/api', file_path: 'a', ref: 'main' }),
    ).toBe('allow');
    expect(
      call('get_repository_file', {
        project_id: 'acme/api',
        url: 'https://gitlab.com/other/secret/-/blob/main/.env',
      }),
    ).toBe('block: url is not allowed: name the project with project_id');
    expect(
      call('get_repository_file', { url: 'https://gitlab.com/other/secret/-/blob/main/a' }),
    ).toMatch(/^block: the repository must be one of/);
    expect(call('list_work_items', { project_id: 'acme/api', group_id: 'acme' })).toMatch(
      /^block: group_id is not allowed/,
    );
    // list_branches names the project with `id`.
    expect(call('list_branches', { id: 'acme/api' })).toBe('allow');
    expect(call('list_branches', { id: 'other/secret' })).toMatch(/^block: the repository/);
  });

  it('commits only whole-file creates and updates, never on the default branch', () => {
    const commit = (actions: unknown, branch = 'kodra-agent/fix') =>
      call('add_commit', { project_id: 'acme/api', branch, commit_message: 'm', actions });
    expect(commit([{ action: 'create', file_path: 'Dockerfile', content: 'FROM x' }])).toBe(
      'approve',
    );
    expect(commit([{ action: 'update', file_path: 'a', content: 'b' }], 'main')).toMatch(
      /^block: main is the default branch/,
    );
    expect(commit([{ action: 'delete', file_path: 'a' }])).toBe(
      "block: each actions item's action must be one of: create, update",
    );
    expect(commit([{ action: 'move', file_path: 'b', previous_path: 'a' }])).toMatch(
      /^block: each actions item's action/,
    );
    // In-place text replacement would get around the preview of the whole file.
    expect(commit([{ action: 'update', file_path: 'a', old_str: 'x', new_str: 'y' }])).toBe(
      'block: actions items cannot set old_str',
    );
    expect(
      commit([{ action: 'create', file_path: 'a', content: 'eA==', encoding: 'base64' }]),
    ).toBe('block: actions items cannot set encoding');
    expect(commit('not a list')).toBe('block: actions must be a list');
  });

  it('opens merge requests from a new branch in the same project only', () => {
    const mr = (extra: Record<string, unknown>) =>
      call('save_merge_request', {
        project_id: 'acme/api',
        title: 't',
        source_branch: 'kodra-agent/fix',
        target_branch: 'main',
        ...extra,
      });
    expect(mr({})).toBe('approve');
    expect(mr({ source_branch: 'main' })).toMatch(/^block: main is the default branch/);
    expect(mr({ target_project_id: 7 })).toMatch(/^block: target_project_id is not allowed/);
  });

  it('places a call in the environment of the project it names, ignoring the other guards', () => {
    expect(touchedBy(guards('add_commit'), { project_id: 'acme/api', actions: [] })).toEqual({
      namespaces: [],
      repos: ['acme/api'],
    });
    expect(describeGuards(guards('add_commit'), settings)).toContain(
      'never pass url: name the project with project_id',
    );
  });
});

describe('GitLab CI and Jenkins on their official servers (B4)', () => {
  it('runs only new pipelines: an existing one is named by a global id', () => {
    const ci = getConnector('gitlab-ci');
    if (!ci) throw new Error('gitlab-ci');
    const run = (args: Record<string, unknown>) =>
      kind(
        decide({
          ...base,
          destructiveActions: 'require-approval',
          risk: ci.tools['save_pipeline'] ?? 'unclassified',
          access: 'read-write-approved',
          guards: ci.guards?.['save_pipeline'] ?? [],
          args,
          settings: {},
          sharedSettings: { gitlab: { projects: ['acme/api'] } },
        }),
      );
    expect(run({ project_id: 'acme/api', ref: 'main' })).toBe('approve');
    expect(run({ project_id: 'acme/api', pipeline_id: 12, action: 'retry' })).toMatch(
      /^block: pipeline_id is not allowed/,
    );
  });

  it('cancels builds of listed jobs only, never a queue item by id', () => {
    const jenkins = getConnector('jenkins');
    if (!jenkins) throw new Error('jenkins');
    const cancel = (args: Record<string, unknown>) =>
      kind(
        decide({
          ...base,
          risk: jenkins.tools['cancelBuild'] ?? 'unclassified',
          access: 'read-write-approved',
          guards: jenkins.guards?.['cancelBuild'] ?? [],
          args,
          settings: { jobs: ['team-a'] },
        }),
      );
    expect(cancel({ jobFullName: 'team-a/deploy', buildNumber: 3 })).toBe('approve');
    expect(cancel({ jobFullName: 'team-b/payroll', buildNumber: 3 })).toMatch(
      /^block: jobFullName/,
    );
    expect(cancel({ queueId: 9 })).toMatch(/^block: jobFullName is required/);
    expect(cancel({ jobFullName: 'team-a/deploy', queueId: 9 })).toMatch(
      /^block: queueId is not allowed/,
    );
    expect(jenkins.hiddenTools).toEqual(expect.arrayContaining(['replayBuild', 'createPipeline']));
  });
});
