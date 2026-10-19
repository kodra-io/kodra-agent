import { describe, expect, it } from 'vitest';
import type { DashboardView, OverviewView, StatusView } from './api.ts';
import { briefing, greetingFor, headlineFor, MAX_ITEMS, nameOf } from './briefing.ts';
import en from './locales/en.json';

const status: StatusView = {
  version: '0.3.5',
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
          title: { en: 'Pods', ar: 'Pods' },
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
          title: { en: 'Deployments', ar: 'Deployments' },
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
          title: { en: 'Pipelines', ar: 'Pipelines' },
          view: 'runs',
          results: [
            {
              target: 'acme/api',
              data: {
                kind: 'runs',
                counts: { passed: 3, failed: 1, running: 0, other: 0 },
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
    expect(b).toEqual({ attention: [], total: 0 });
    expect(headlineFor(b.total)).toBe('welcome.allQuiet');
  });

  it('puts what needs a person first, then what the connectors see', () => {
    const b = briefing({
      status: {
        ...status,
        connectors: [...status.connectors, { id: 'aws', name: 'AWS', available: false }],
      },
      pending: 1,
      overview: { ...overview, investigationsToday: 2 },
      dashboard,
    });
    expect(b.total).toBe(6);
    expect(keys(b)).toEqual([
      'welcome.approvals.one',
      'welcome.podsFailingIn.other',
      'welcome.notReady.other',
      'welcome.runsFailed.one',
      'welcome.connectorsDown.one',
    ]);
    expect(b.attention).toHaveLength(MAX_ITEMS);
    expect(b.attention[1]).toEqual({
      key: 'welcome.podsFailingIn.other',
      vars: { n: 2, where: 'dev' },
      to: '/dashboard',
    });
    expect(b.attention[4]?.vars).toEqual({ n: 1, names: 'AWS' });
    expect(headlineFor(b.total)).toBe('welcome.needsYou.other');
  });

  it('leads with a pause, and warns about the budget near and over the limit', () => {
    const paused = { ...status, paused: { by: 'console:omar', at: '2026-10-19T07:00:00.000Z' } };
    expect(keys(briefing({ status: paused, pending: 0, overview, dashboard: null }))).toEqual([
      'welcome.paused',
    ]);
    const near = { ...status, budget: { month: '2026-10', limit: 40, spent: 34, over: false } };
    const b = briefing({ status: near, pending: 0, overview, dashboard: null });
    expect(b.attention).toEqual([{ key: 'welcome.budgetNear', vars: { share: 85 }, to: '/usage' }]);
    const over = { ...status, budget: { month: '2026-10', limit: 40, spent: 41, over: true } };
    expect(keys(briefing({ status: over, pending: 0, overview, dashboard: null }))).toEqual([
      'welcome.budgetOver',
    ]);
    // No limit, or no price: nothing to say about the budget.
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
      { key: 'welcome.podsFailing.other', vars: { n: 2, where: '' }, to: '/dashboard' },
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
    for (const n of [0, 1, 2]) expect(Object.keys(en)).toContain(headlineFor(n));
  });
});
