import { describe, expect, it } from 'vitest';
import type { DashboardView, OverviewView, StatusView } from './api.ts';
import {
  briefing,
  greetingFor,
  MAX_ITEMS,
  nameOf,
  runsToday,
  systemsOf,
  totalsOf,
} from './briefing.ts';
import en from './locales/en.json';

/** An ISO time for a day of October 2026 in the machine's own time zone. */
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).toISOString();

const status: StatusView = {
  version: '0.3.9',
  model: 'ollama/gemma4:e4b',
  target: 'compose',
  startedAt: '2026-10-19T06:00:00.000Z',
  uptimeSeconds: 60,
  slack: false,
  monitoring: false,
  connectors: [
    { id: 'gitlab', name: 'GitLab', available: true },
    { id: 'kubernetes', name: 'Kubernetes', available: true },
  ],
  paused: null,
  budget: { month: '2026-10', limit: 40, spent: 12.4, over: false },
};

const overview: OverviewView = {
  investigationsToday: 0,
  lastInvestigation: null,
  changesThisWeek: { approved: 0, denied: 0, expired: 0 },
  recentChanges: [],
};

const dashboard: DashboardView = {
  updatedAt: '2026-10-19T08:00:00.000Z',
  connectors: [
    {
      id: 'kubernetes',
      displayName: 'Kubernetes',
      panels: [
        {
          id: 'pods',
          title: 'Pods',
          view: 'pods',
          results: [
            {
              target: 'dev',
              data: {
                kind: 'pods',
                counts: { running: 2, pending: 0, failing: 2, completed: 0 },
                pods: [],
              },
            },
            { target: 'prod', error: 'pods is forbidden' },
          ],
        },
        {
          id: 'deployments',
          title: 'Deployments',
          view: 'deployments',
          results: [
            { target: 'dev', data: { kind: 'deployments', ready: 1, total: 3, deployments: [] } },
          ],
        },
      ],
    },
    {
      id: 'gitlab-ci',
      displayName: 'GitLab CI',
      panels: [
        {
          id: 'pipelines',
          title: 'Pipelines',
          view: 'runs',
          results: [
            {
              target: 'acme/api',
              data: {
                kind: 'runs',
                counts: { passed: 3, failed: 1, running: 0, other: 0 },
                recent: [
                  { at: local(19, 9), state: 'failed' },
                  { at: local(19, 0, 30), state: 'passed' },
                  { at: local(18, 23, 30), state: 'passed' },
                  { at: local(18, 10), state: 'passed' },
                ],
                full: false,
                runs: [],
              },
            },
          ],
        },
      ],
    },
  ],
};

const keys = (b: ReturnType<typeof briefing>) => b.attention.map((i) => i.key);

describe('greeting', () => {
  it.each([
    [5, 'welcome.morning'],
    [11, 'welcome.morning'],
    [12, 'welcome.afternoon'],
    [17, 'welcome.afternoon'],
    [18, 'welcome.evening'],
    [23, 'welcome.evening'],
    [0, 'welcome.evening'],
    [4, 'welcome.evening'],
  ])('at %i h says %s', (hour, key) => {
    expect(greetingFor(hour)).toBe(key);
  });

  it('greets console approvers by name, not the shared token or the built-in admin', () => {
    expect(nameOf('console:omar')).toBe('Omar');
    expect(nameOf('console:admin')).toBeNull();
    expect(nameOf('console')).toBeNull();
  });
});

describe('briefing', () => {
  it('is quiet when nothing needs anyone', () => {
    const b = briefing({ status, pending: 0, overview, dashboard: null });
    expect(b).toEqual({ posture: 'nominal', attention: [], total: 0 });
  });

  it('ranks the queue worst first: broken, then decisions owed, then risks, then notes', () => {
    const b = briefing({
      status: {
        ...status,
        connectors: [...status.connectors, { id: 'aws', name: 'AWS', available: false }],
      },
      pending: 1,
      overview: { ...overview, investigationsToday: 2 },
      dashboard,
    });
    expect(b.posture).toBe('critical');
    expect(b.total).toBe(6);
    expect(b.attention.map((i) => [i.severity, i.key])).toEqual([
      ['critical', 'welcome.podsFailingIn.other'],
      ['critical', 'welcome.connectorsDown.one'],
      ['action', 'welcome.approvals.one'],
      ['warning', 'welcome.notReady.other'],
      ['warning', 'welcome.runsFailed.one'],
      ['info', 'welcome.investigations.other'],
    ]);
    expect(b.attention[0]).toMatchObject({ vars: { n: 2, where: 'dev' }, to: '/dashboard' });
    expect(b.attention[1]?.vars).toEqual({ n: 1, names: 'AWS' });
  });

  it('cuts the queue to MAX_ITEMS and keeps the count', () => {
    const many = {
      ...status,
      paused: { by: 'console:omar', at: '' },
      budget: { month: '2026-10', limit: 40, spent: 41, over: true },
      connectors: [{ id: 'aws', name: 'AWS', available: false }],
    };
    const b = briefing({
      status: many,
      pending: 3,
      overview: { ...overview, investigationsToday: 1 },
      dashboard,
    });
    expect(b.total).toBe(8);
    expect(b.attention).toHaveLength(MAX_ITEMS);
    expect(b.attention.at(-1)?.severity).toBe('warning');
  });

  it('is degraded, not critical, when only decisions or risks are open', () => {
    expect(briefing({ status, pending: 2, overview, dashboard: null }).posture).toBe('degraded');
    // Investigations alone are a note.
    const noted = { ...overview, investigationsToday: 1 };
    expect(briefing({ status, pending: 0, overview: noted, dashboard: null }).posture).toBe(
      'nominal',
    );
  });

  it('flags a pause, and the budget near and over the limit', () => {
    const paused = { ...status, paused: { by: 'console:omar', at: '2026-10-19T07:00:00.000Z' } };
    expect(keys(briefing({ status: paused, pending: 0, overview, dashboard: null }))).toEqual([
      'welcome.paused',
    ]);
    const near = { ...status, budget: { month: '2026-10', limit: 40, spent: 34, over: false } };
    expect(briefing({ status: near, pending: 0, overview, dashboard: null }).attention).toEqual([
      { key: 'welcome.budgetNear', vars: { share: 85 }, severity: 'warning', to: '/usage' },
    ]);
    const over = { ...status, budget: { month: '2026-10', limit: 40, spent: 41, over: true } };
    const b = briefing({ status: over, pending: 0, overview, dashboard: null });
    expect(b.attention.map((i) => [i.severity, i.key])).toEqual([
      ['critical', 'welcome.budgetOver'],
    ]);
    // No price: nothing to say about the budget.
    const unpriced = {
      ...status,
      budget: { month: '2026-10', limit: 40, spent: null, over: false },
    };
    expect(briefing({ status: unpriced, pending: 0, overview, dashboard: null }).total).toBe(0);
  });

  it('counts pods without a namespace when the card has no target', () => {
    const pods = dashboard.connectors[0]?.panels[0];
    if (!pods) throw new Error('no pods panel');
    const untargeted: DashboardView = {
      ...dashboard,
      connectors: [
        {
          id: 'kubernetes',
          displayName: 'Kubernetes',
          panels: [{ ...pods, results: [{ ...pods.results[0], target: null }] }],
        },
      ],
    };
    expect(briefing({ status, pending: 0, overview, dashboard: untargeted }).attention).toEqual([
      {
        key: 'welcome.podsFailing.other',
        vars: { n: 2, where: '' },
        severity: 'critical',
        to: '/dashboard',
      },
    ]);
  });

  it('only uses messages that exist', () => {
    const b = briefing({
      status: { ...status, paused: { by: 'x', at: '' } },
      pending: 2,
      overview: { ...overview, investigationsToday: 1 },
      dashboard,
    });
    for (const item of b.attention) expect(Object.keys(en)).toContain(item.key);
    for (const s of systemsOf(status, dashboard)) expect(Object.keys(en)).toContain(s.metric.key);
  });
});

/** The Kubernetes connector with two listed databases: one degraded, one unreadable. */
const withDatabases = (db: 'ok' | 'down'): DashboardView => ({
  ...dashboard,
  connectors: [
    {
      id: 'kubernetes',
      displayName: 'Kubernetes',
      panels: [
        {
          id: 'databases',
          title: 'Databases',
          view: 'workload',
          results: [
            {
              target: 'prod/mariadb',
              data: {
                kind: 'workload',
                name: 'mariadb',
                state: db,
                ready: db === 'ok' ? 2 : 0,
                total: 2,
                restarts: 4,
                pods: [],
              },
            },
            { target: 'prod/redis', error: 'pods is forbidden' },
          ],
        },
      ],
    },
  ],
});

describe('pipelines today and databases', () => {
  it("counts today's runs in the viewer's day, and says when there may be more", () => {
    // The runs are in local time: 00:30 counts, 23:30 the evening before does not.
    const at = new Date(2026, 9, 19, 12);
    expect(runsToday(dashboard, at)).toEqual({
      ran: 2,
      passed: 1,
      failed: 1,
      running: 0,
      atLeast: false,
    });
    expect(runsToday(null, at)).toBeNull();
    // A full page, all of it from today: older runs of today may be cut off.
    const gitlab = dashboard.connectors[1];
    const pipelines = gitlab?.panels[0];
    const result = pipelines?.results[0];
    if (!gitlab || !pipelines || result?.data?.kind !== 'runs') throw new Error('fixture');
    const busy: DashboardView = {
      ...dashboard,
      connectors: [
        {
          ...gitlab,
          panels: [
            {
              ...pipelines,
              results: [
                {
                  ...result,
                  data: { ...result.data, recent: result.data.recent.slice(0, 2), full: true },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(runsToday(busy, at)).toMatchObject({ ran: 2, atLeast: true });
  });

  it('lights each database, and puts one that is down or not ready in the queue', () => {
    const down = withDatabases('down');
    expect(totalsOf(down).databases).toEqual([
      {
        target: 'prod/mariadb',
        state: 'down',
        source: 'kubernetes',
        ready: 0,
        total: 2,
        restarts: 4,
        connections: null,
      },
      {
        target: 'prod/redis',
        state: 'unknown',
        source: 'kubernetes',
        ready: 0,
        total: 0,
        restarts: 0,
        connections: null,
      },
    ]);
    const b = briefing({ status, pending: 0, overview, dashboard: down });
    expect(b.posture).toBe('critical');
    expect(b.attention.map((i) => [i.severity, i.key, i.vars])).toEqual([
      ['critical', 'welcome.databasesDown.one', { n: 1, names: 'prod/mariadb' }],
      ['warning', 'welcome.databasesDegraded.one', { n: 1, names: 'prod/redis' }],
    ]);
    expect(systemsOf(status, down).map((s) => [s.name, s.state, s.metric.key])).toEqual([
      ['GitLab', 'ok', 'welcome.sys.online'],
      // A database the card cannot read does not make Kubernetes itself look broken.
      ['Kubernetes', 'ok', 'welcome.sys.online'],
      ['prod/mariadb', 'down', 'welcome.sys.db'],
      ['prod/redis', 'warn', 'welcome.sys.unreadable'],
    ]);
    const ok = briefing({ status, pending: 0, overview, dashboard: withDatabases('ok') });
    expect(ok.attention.map((i) => i.key)).toEqual(['welcome.databasesDegraded.one']);
  });

  it('counts databases the agent connects to with those in Kubernetes, wherever they run', () => {
    const both: DashboardView = {
      ...withDatabases('ok'),
      connectors: [
        ...withDatabases('ok').connectors,
        {
          id: 'databases',
          displayName: 'Databases',
          panels: [
            {
              id: 'databases',
              title: 'Databases',
              view: 'database',
              results: [
                {
                  target: 'orders',
                  data: {
                    kind: 'database',
                    name: 'orders',
                    engine: 'mariadb',
                    via: 'tunnel',
                    state: 'ok',
                    reasons: [],
                    version: '11.4.3-MariaDB',
                    uptimeSeconds: 100,
                    connections: { used: 12, max: 151 },
                    readOnly: false,
                    replicaLagSeconds: null,
                    latencyMs: 40,
                  },
                },
                {
                  target: 'billing',
                  data: {
                    kind: 'database',
                    name: 'billing',
                    engine: 'postgres',
                    via: 'direct',
                    state: 'down',
                    reasons: ['the user or password was refused'],
                    version: null,
                    uptimeSeconds: null,
                    connections: null,
                    readOnly: null,
                    replicaLagSeconds: null,
                    latencyMs: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const t = totalsOf(both);
    expect(t.databases.map((d) => [d.target, d.source, d.state])).toEqual([
      ['prod/mariadb', 'kubernetes', 'ok'],
      ['prod/redis', 'kubernetes', 'unknown'],
      ['orders', 'connection', 'ok'],
      ['billing', 'connection', 'down'],
    ]);
    const statusWithDb = {
      ...status,
      connectors: [
        ...status.connectors,
        { ...status.connectors[0], id: 'databases', name: 'Databases', available: true },
      ],
    };
    const systems = systemsOf(statusWithDb, both).filter((s) => s.id.startsWith('db:'));
    expect(systems.map((s) => [s.name, s.state, s.metric.key, s.metric.vars])).toEqual([
      ['prod/mariadb', 'ok', 'welcome.sys.db', { ready: 2, total: 2, restarts: 4 }],
      ['prod/redis', 'warn', 'welcome.sys.unreadable', {}],
      ['orders', 'ok', 'welcome.sys.dbConnections', { used: 12, max: 151 }],
      ['billing', 'down', 'welcome.sys.dbDown', {}],
    ]);
    // The Databases connector itself is up: its databases have their own lights.
    expect(systemsOf(statusWithDb, both).find((s) => s.id === 'databases')?.state).toBe('ok');
    const b = briefing({ status: statusWithDb, pending: 0, overview, dashboard: both });
    expect(b.attention[0]).toMatchObject({
      severity: 'critical',
      key: 'welcome.databasesDown.one',
      vars: { names: 'billing' },
    });
  });
});

describe('totals and systems', () => {
  it('adds the dashboard up across connectors and namespaces', () => {
    expect(totalsOf(dashboard)).toMatchObject({
      podsRunning: 2,
      podsFailing: 2,
      podsTotal: 4,
      deploymentsReady: 1,
      deploymentsTotal: 3,
      runsPassed: 3,
      runsFailed: 1,
      failingIn: ['dev'],
      seen: { pods: true, deployments: true, runs: true },
    });
    expect(totalsOf(null).seen).toEqual({
      pods: false,
      deployments: false,
      runs: false,
      databases: false,
    });
  });

  it('lights each system: down when it did not start, amber on trouble, green otherwise', () => {
    const board = systemsOf(
      {
        ...status,
        connectors: [
          { id: 'kubernetes', name: 'Kubernetes', available: true },
          { id: 'gitlab-ci', name: 'GitLab CI', available: true },
          { id: 'gitlab', name: 'GitLab', available: true },
          { id: 'aws', name: 'AWS', available: false },
        ],
      },
      dashboard,
    );
    expect(board.map((s) => [s.name, s.state, s.metric.key, s.metric.vars])).toEqual([
      ['Kubernetes', 'warn', 'welcome.sys.pods', { up: 2, total: 4 }],
      ['GitLab CI', 'warn', 'welcome.sys.runs', { failed: 1, passed: 3 }],
      ['GitLab', 'ok', 'welcome.sys.online', {}],
      ['AWS', 'down', 'welcome.sys.offline', {}],
    ]);
  });
});
