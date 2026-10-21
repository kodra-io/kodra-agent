import { readFileSync } from 'node:fs';
import { connectors, getConnector } from '@kodra-agent/connectors';
import { manifestSchema, type DashboardView, type ToolGuard } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import {
  ConnectorDashboard,
  DASHBOARD_TTL_MS,
  parseTable,
  parseView,
  podOf,
  runState,
  type DeploymentsData,
  type EventsData,
  type JobsData,
  type PodsData,
  type RunsData,
  type WorkloadData,
} from './dashboard.ts';
import type { HostedTool, ToolCallResult } from './mcp/host.ts';
import { Redactor } from './redactor.ts';

// Recorded from kubernetes-mcp-server v0.0.67 on kind: two healthy nginx pods, one pod that
// exits (CrashLoop/Error), and one with an image tag that does not exist.
const fixture = (name: string) =>
  readFileSync(new URL(`./test-fixtures/dashboard/${name}`, import.meta.url), 'utf8');

const GITLAB_RUNS = JSON.stringify([
  {
    id: 101,
    project_id: 7,
    ref: 'main',
    status: 'success',
    web_url: 'https://gitlab.com/acme/api/-/pipelines/101',
    created_at: '2026-10-17T08:00:00Z',
  },
  {
    id: 102,
    project_id: 7,
    ref: 'feature/x',
    status: 'failed',
    web_url: 'javascript:alert(1)',
    created_at: '2026-10-17T09:00:00Z',
  },
  {
    id: 103,
    project_id: 7,
    ref: 'main',
    status: 'running',
    web_url: 'https://gitlab.com/acme/api/-/pipelines/103',
    created_at: '2026-10-17T10:00:00Z',
  },
]);

const GITHUB_RUNS = JSON.stringify({
  total_count: 2,
  workflow_runs: [
    {
      id: 9,
      name: 'CI',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/web/actions/runs/9',
      created_at: '2026-10-17T10:00:00Z',
    },
    {
      id: 10,
      name: 'CI',
      head_branch: 'main',
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/acme/web/actions/runs/10',
      created_at: '2026-10-17T11:00:00Z',
    },
  ],
});

const runsView = (manifest: string): DashboardView => {
  const view = getConnector(manifest)?.dashboard?.[0]?.view;
  if (!view) throw new Error(`no dashboard in ${manifest}`);
  return view;
};

describe('dashboard readers: Jenkins jobs', () => {
  const view = getConnector('jenkins')?.dashboard?.[0]?.view;
  if (view?.kind !== 'jobs') throw new Error('no Jenkins jobs card');

  it('reads the real job list: colors to states, failed first', () => {
    // Recorded from mcp-jenkins 3.5.0 on Jenkins LTS: one passing and one failing job.
    const data = parseView(view, fixture('jenkins-items.json'), {
      jobs: ['api-tests', 'deploy-web'],
    }) as JobsData;
    expect(data.counts).toEqual({ passed: 1, failed: 1, running: 0, other: 0 });
    expect(data.jobs.map((j) => [j.name, j.state, j.status])).toEqual([
      ['deploy-web', 'failed', 'red'],
      ['api-tests', 'passed', 'blue'],
    ]);
    expect(data.jobs[0]?.url).toBe('http://localhost:18080/job/deploy-web/');
  });

  it('keeps only the listed jobs and folders, like the guards', () => {
    const items = JSON.stringify([
      {
        fullname: 'team-a/api',
        color: 'blue_anime',
        url: 'https://ci.example.com/job/team-a/job/api/',
      },
      { fullname: 'team-a/web', color: 'notbuilt', url: 'javascript:alert(1)' },
      { fullname: 'team-ab/secret', color: 'red', url: 'https://ci.example.com/x' },
      { fullname: 'team-b/payroll', color: 'red', url: 'https://ci.example.com/y' },
    ]);
    const data = parseView(view, items, { jobs: ['team-a'] }) as JobsData;
    expect(data.jobs.map((j) => [j.name, j.state])).toEqual([
      ['team-a/api', 'running'],
      ['team-a/web', 'other'],
    ]);
    expect(data.jobs[1]?.url).toBeNull();
    // Nothing listed: nothing shown.
    expect((parseView(view, items, {}) as JobsData).jobs).toEqual([]);
  });
});

describe('dashboard readers', () => {
  it('reads pods from the real table: running, failing, and restarts', () => {
    const data = parseView({ kind: 'pods' }, fixture('kubernetes-pods.txt')) as PodsData;
    expect(data.counts).toEqual({ running: 2, pending: 0, failing: 2, completed: 0 });
    expect(data.pods.map((p) => p.name)).toEqual([
      expect.stringMatching(/^broken-/),
      expect.stringMatching(/^badimage-/),
    ]);
    expect(data.pods[0]).toMatchObject({ namespace: 'dev', status: 'Error', ready: '0/1' });
    // "6 (2m58s ago)" keeps its single spaces and counts as 6.
    expect(data.pods[0]?.restarts).toBe(6);
  });

  it('reads deployments: ready against desired, not-ready ones first', () => {
    const data = parseView(
      { kind: 'deployments' },
      fixture('kubernetes-deployments.txt'),
    ) as DeploymentsData;
    expect(data).toMatchObject({ ready: 1, total: 3 });
    expect(data.deployments.map((d) => [d.name, d.ready, d.desired])).toEqual([
      ['badimage', 0, 1],
      ['broken', 0, 1],
      ['web', 2, 2],
    ]);
  });

  it('reads warning events only, latest first, one row per reason and object', () => {
    const data = parseView({ kind: 'events' }, fixture('kubernetes-events.txt')) as EventsData;
    expect(data.warnings.length).toBeGreaterThan(0);
    for (const w of data.warnings) expect(w.object).toMatch(/^Pod\/(badimage|broken)-/);
    const keys = data.warnings.map((w) => `${w.reason} ${w.object}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(data.warnings.some((w) => w.message === 'Error: ImagePullBackOff' && w.count > 1)).toBe(
      true,
    );
  });

  it('reads empty namespaces as nothing to show, not as an error', () => {
    expect(parseView({ kind: 'pods' }, fixture('kubernetes-pods-empty.txt'))).toMatchObject({
      counts: { running: 0, pending: 0, failing: 0, completed: 0 },
    });
    expect(
      parseView({ kind: 'deployments' }, fixture('kubernetes-deployments-empty.txt')),
    ).toMatchObject({ total: 0 });
    expect(parseView({ kind: 'events' }, fixture('kubernetes-events-empty.txt'))).toEqual({
      kind: 'events',
      warnings: [],
    });
  });

  it('refuses output it cannot read', () => {
    expect(parseTable('NAME  READY\nweb   1/1')).toEqual([{ NAME: 'web', READY: '1/1' }]);
    expect(parseView({ kind: 'pods' }, 'web  1/1  Running')).toBeNull();
    expect(parseView(runsView('gitlab-ci'), 'not json')).toBeNull();
    expect(parseView(runsView('gitlab-ci'), '{"no":"list"}')).toBeNull();
  });

  it('reads GitLab pipelines, and drops links that are not web links', () => {
    const data = parseView(runsView('gitlab-ci'), GITLAB_RUNS) as RunsData;
    expect(data.counts).toEqual({ passed: 1, failed: 1, running: 1, other: 0 });
    // Every listed run's time and state, for the console to count a day in its time zone.
    expect(data.recent).toEqual([
      { at: '2026-10-17T08:00:00Z', state: 'passed' },
      { at: '2026-10-17T09:00:00Z', state: 'failed' },
      { at: '2026-10-17T10:00:00Z', state: 'running' },
    ]);
    // A page shorter than asked for is everything; a full one may have more behind it.
    expect(data.full).toBe(false);
    expect((parseView(runsView('gitlab-ci'), GITLAB_RUNS, {}, { limit: 3 }) as RunsData).full).toBe(
      true,
    );
    expect(data.runs[1]).toMatchObject({ id: '102', ref: 'feature/x', state: 'failed', url: null });
    expect(data.runs[0]?.url).toBe('https://gitlab.com/acme/api/-/pipelines/101');
  });

  it('reads GitHub workflow runs: the conclusion, else the status', () => {
    const data = parseView(runsView('github-actions'), GITHUB_RUNS) as RunsData;
    expect(data.counts).toEqual({ passed: 0, failed: 1, running: 1, other: 0 });
    expect(data.runs.map((r) => [r.name, r.status])).toEqual([
      ['CI', 'failure'],
      ['CI', 'in_progress'],
    ]);
    expect(runState('canceled')).toBe('other');
  });
});

describe('dashboard readers: a database', () => {
  const view: DashboardView = { kind: 'database' };
  const health = {
    name: 'orders',
    engine: 'mariadb',
    via: 'tunnel',
    state: 'degraded',
    reasons: ['140 of 151 connections in use'],
    version: '11.4.3-MariaDB',
    uptimeSeconds: 3600,
    connections: { used: 140, max: 151 },
    readOnly: false,
    replicaLagSeconds: null,
    latencyMs: 42,
    checkedAt: '2026-10-21T08:00:00.000Z',
  };

  it("keeps the health check's known fields", () => {
    expect(parseView(view, JSON.stringify(health))).toEqual({
      kind: 'database',
      name: 'orders',
      engine: 'mariadb',
      via: 'tunnel',
      state: 'degraded',
      reasons: ['140 of 151 connections in use'],
      version: '11.4.3-MariaDB',
      uptimeSeconds: 3600,
      connections: { used: 140, max: 151 },
      readOnly: false,
      replicaLagSeconds: null,
      latencyMs: 42,
    });
  });

  it('refuses what is not a health check, and drops fields of the wrong type', () => {
    expect(parseView(view, 'not json')).toBeNull();
    expect(parseView(view, JSON.stringify({ ...health, state: 'great' }))).toBeNull();
    expect(
      parseView(
        view,
        JSON.stringify({ ...health, connections: { used: -1, max: 'x' }, reasons: [1, 'ok'] }),
      ),
    ).toMatchObject({ connections: null, reasons: ['ok'] });
  });
});

describe('dashboard readers: a workload', () => {
  const view: DashboardView = { kind: 'workload' };
  const table = [
    'NAMESPACE   NAME         READY   STATUS             RESTARTS        AGE',
    'prod        mariadb-0    1/1     Running            0               3d',
    'prod        mariadb-1    0/1     Running            3 (1m ago)      3d',
    'prod        mariadbx-0   1/1     Running            0               3d',
  ].join('\n');

  it("keeps only the named workload's pods: ready, restarts, and its state", () => {
    expect(parseView(view, table, {}, { match: 'mariadb' })).toEqual({
      kind: 'workload',
      name: 'mariadb',
      state: 'degraded',
      ready: 1,
      total: 2,
      restarts: 3,
      pods: [
        { name: 'mariadb-0', status: 'Running', ready: '1/1', restarts: 0 },
        { name: 'mariadb-1', status: 'Running', ready: '0/1', restarts: 3 },
      ],
    });
  });

  it('is down when nothing of it runs, or it has no pods at all', () => {
    const real = fixture('kubernetes-pods.txt');
    expect(parseView(view, real, {}, { match: 'broken' })).toMatchObject({
      state: 'down',
      ready: 0,
      total: 1,
      restarts: 6,
    });
    expect(parseView(view, table, {}, { match: 'postgres' })).toMatchObject({
      state: 'down',
      total: 0,
      pods: [],
    });
    expect(parseView(view, table)).toBeNull();
  });

  it("matches the names Kubernetes gives a workload's pods, and no other", () => {
    expect(podOf('mariadb', 'mariadb-0')).toBe(true);
    expect(podOf('web', 'web-7c6cdd646-4jqkc')).toBe(true);
    expect(podOf('agent', 'agent-x7k2p')).toBe(true);
    expect(podOf('maria', 'mariadb-0')).toBe(false);
    expect(podOf('mariadb', 'mariadbx-0')).toBe(false);
    expect(podOf('web', 'web-admin-7c6cdd646-4jqkc')).toBe(false);
  });
});

/** A hosted read tool, as the host would list it. */
function hosted(over: Partial<HostedTool> & { name: string; tool: string }): HostedTool {
  return {
    connector: over.name.split('__')[0] ?? '',
    description: '',
    inputSchema: {},
    risk: 'read',
    guards: [],
    access: 'read-only',
    settings: {},
    server: 0,
    ...over,
  };
}

function fakeHost(
  tools: HostedTool[],
  answer: (name: string, args: Record<string, unknown>) => ToolCallResult,
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    get: (name: string) => tools.find((t) => t.name === name),
    call: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve(answer(name, args));
    },
  };
}

describe('ConnectorDashboard', () => {
  const kubernetes = getConnector('kubernetes');
  const githubActions = getConnector('github-actions');
  if (!kubernetes || !githubActions) throw new Error('manifests missing');
  const settings = { namespaces: ['dev', 'prod'] };
  const k8sTools = [
    hosted({
      name: 'kubernetes__pods_list_in_namespace',
      tool: 'pods_list_in_namespace',
      settings,
      guards: kubernetes.guards?.['pods_list_in_namespace'] ?? [],
    }),
    hosted({
      name: 'kubernetes__resources_list',
      tool: 'resources_list',
      settings,
      guards: kubernetes.guards?.['resources_list'] ?? [],
    }),
    // events_list is not running (say its server dropped it).
  ];

  it('calls each card once per namespace, through the policy, and caches for a minute', async () => {
    let now = 1_000_000;
    const host = fakeHost(k8sTools, (name) => ({
      isError: false,
      text: fixture(
        name.endsWith('pods_list_in_namespace')
          ? 'kubernetes-pods.txt'
          : 'kubernetes-deployments.txt',
      ),
    }));
    const dashboard = new ConnectorDashboard({
      host,
      redactor: new Redactor(),
      policy: { destructiveActions: 'deny', self: null },
      manifests: [kubernetes],
      now: () => now,
    });
    const view = await dashboard.view();
    const panels = view.connectors[0]?.panels ?? [];
    expect(panels.map((p) => [p.id, p.note ?? 'ok', p.results.map((r) => r.target)])).toEqual([
      ['pods', 'ok', ['dev', 'prod']],
      ['deployments', 'ok', ['dev', 'prod']],
      ['warnings', 'unavailable', []],
      // No databases listed: nothing to watch.
      ['databases', 'no-targets', []],
    ]);
    expect(host.calls).toContainEqual({
      name: 'kubernetes__resources_list',
      args: { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'prod' },
    });
    expect(host.calls).toHaveLength(4);

    // Within the minute, one refresh serves everyone; after it, a new one.
    await Promise.all([dashboard.view(), dashboard.view()]);
    expect(host.calls).toHaveLength(4);
    now += DASHBOARD_TTL_MS;
    await dashboard.view();
    expect(host.calls).toHaveLength(8);
  });

  it('splits owner/repo, redacts output, and shows tool errors per target', async () => {
    const redactor = new Redactor();
    redactor.add('ghp_a-secret-that-leaked-1234567890');
    const tools = [
      hosted({
        name: 'github-actions__actions_list',
        tool: 'actions_list',
        sharedSettings: { github: { repos: ['acme/web', 'acme/api', 'not-a-repo'] } },
      }),
    ];
    const host = fakeHost(tools, (_name, args) =>
      args['repo'] === 'web'
        ? {
            isError: false,
            text: GITHUB_RUNS.replace('"CI"', '"ghp_a-secret-that-leaked-1234567890"'),
          }
        : { isError: true, text: 'Resource not accessible by personal access token' },
    );
    const view = await new ConnectorDashboard({
      host,
      redactor,
      policy: { destructiveActions: 'deny', self: null },
      manifests: [githubActions],
    }).view();
    expect(host.calls.map((c) => [c.args['owner'], c.args['repo'], c.args['method']])).toEqual([
      ['acme', 'web', 'list_workflow_runs'],
      ['acme', 'api', 'list_workflow_runs'],
    ]);
    const [web, api] = view.connectors[0]?.panels[0]?.results ?? [];
    expect(JSON.stringify(web)).not.toContain('ghp_a-secret');
    expect((web?.data as RunsData).counts.failed).toBe(1);
    expect(api).toEqual({
      target: 'acme/api',
      error: 'Resource not accessible by personal access token',
    });
  });

  it('says when there is nothing to list, and never calls a tool that is not a read', async () => {
    const host = fakeHost(
      [
        hosted({
          name: 'kubernetes__pods_list_in_namespace',
          tool: 'pods_list_in_namespace',
          settings: { namespaces: [] },
        }),
        hosted({
          name: 'kubernetes__resources_list',
          tool: 'resources_list',
          risk: 'write',
          settings,
        }),
      ],
      () => ({ isError: false, text: '' }),
    );
    const view = await new ConnectorDashboard({
      host,
      redactor: new Redactor(),
      policy: { destructiveActions: 'deny', self: null },
      manifests: [kubernetes],
    }).view();
    expect(view.connectors[0]?.panels.map((p) => p.note)).toEqual([
      'no-targets',
      'unavailable',
      'unavailable',
      'no-targets',
    ]);
    expect(host.calls).toHaveLength(0);
  });

  it('applies the guards: a target the guard does not allow is refused before any call', async () => {
    // The card loops over `namespaces`; this guard allows only the ones in `allowed`.
    const guard: ToolGuard = {
      kind: 'arg-in-setting',
      arg: 'namespace',
      setting: 'allowed',
      required: true,
      scope: 'namespace',
    };
    const host = fakeHost(
      [
        hosted({
          name: 'kubernetes__pods_list_in_namespace',
          tool: 'pods_list_in_namespace',
          settings: { namespaces: ['dev', 'kube-system'], allowed: ['dev'] },
          guards: [guard],
        }),
      ],
      () => ({ isError: false, text: fixture('kubernetes-pods-empty.txt') }),
    );
    const dashboard = new ConnectorDashboard({
      host,
      redactor: new Redactor(),
      policy: { destructiveActions: 'deny', self: null },
      manifests: [{ ...kubernetes, dashboard: kubernetes.dashboard?.slice(0, 1) ?? [] }],
    });
    const results = (await dashboard.view()).connectors[0]?.panels[0]?.results ?? [];
    expect(results[0]).toMatchObject({ target: 'dev', data: { kind: 'pods' } });
    expect(results[1]?.target).toBe('kube-system');
    expect(results[1]?.error).toMatch(/namespace/);
    expect(host.calls.map((c) => c.args['namespace'])).toEqual(['dev']);
  });
});

describe('ConnectorDashboard: databases', () => {
  it('reads each namespace/name entry in its namespace, through the namespace guard', async () => {
    const kubernetes = getConnector('kubernetes');
    if (!kubernetes) throw new Error('missing');
    const host = fakeHost(
      [
        hosted({
          name: 'kubernetes__pods_list_in_namespace',
          tool: 'pods_list_in_namespace',
          settings: { namespaces: ['dev'], databases: ['dev/web', 'prod/db', 'not-scoped'] },
          guards: kubernetes.guards?.['pods_list_in_namespace'] ?? [],
        }),
      ],
      () => ({ isError: false, text: fixture('kubernetes-pods.txt') }),
    );
    const view = await new ConnectorDashboard({
      host,
      redactor: new Redactor(),
      policy: { destructiveActions: 'deny', self: null },
      manifests: [
        {
          ...kubernetes,
          dashboard: kubernetes.dashboard?.filter((p) => p.id === 'databases') ?? [],
        },
      ],
    }).view();
    const [web, db] = view.connectors[0]?.panels[0]?.results ?? [];
    expect(web).toMatchObject({
      target: 'dev/web',
      data: { kind: 'workload', name: 'web', state: 'ok' },
    });
    expect((web?.data as WorkloadData).ready).toBe(2);
    // prod is not a listed namespace: refused before any call.
    expect(db?.target).toBe('prod/db');
    expect(db?.error).toMatch(/namespace/);
    expect(host.calls).toEqual([
      { name: 'kubernetes__pods_list_in_namespace', args: { namespace: 'dev' } },
    ]);
  });
});

describe('dashboard manifests', () => {
  it('uses only read tools, and refuses a card on any other tool', () => {
    for (const m of connectors) {
      for (const panel of m.dashboard ?? [])
        expect(m.tools[panel.tool], `${m.id} ${panel.id}`).toBe('read');
    }
    const kubernetes = getConnector('kubernetes');
    if (!kubernetes) throw new Error('missing');
    const bad = manifestSchema.safeParse({
      ...kubernetes,
      dashboard: [{ ...kubernetes.dashboard?.[0], tool: 'resources_scale' }],
    });
    expect(bad.success).toBe(false);
    // A workload card needs namespace/name entries, and only it may have them.
    const pods = kubernetes.dashboard?.[0];
    if (!pods?.forEach) throw new Error('missing');
    for (const panel of [
      { ...pods, view: { kind: 'workload' } },
      { ...pods, forEach: { ...pods.forEach, scoped: true } },
    ]) {
      expect(manifestSchema.safeParse({ ...kubernetes, dashboard: [panel] }).success).toBe(false);
    }
  });
});
