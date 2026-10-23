import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, type ChainCheck } from '../audit.ts';
import { parseView, type DashboardResult, type PanelData, type PanelResult } from '../dashboard.ts';
import { Redactor } from '../redactor.ts';
import { tempDir } from '../test-helpers.ts';
import { digestText, isClean } from './digest.ts';
import { agentFindings, alertFindings, dashboardFindings } from './rules.ts';
import { CheckRunner } from './runner.ts';
import { ChecksState } from './state.ts';

// Recorded from kubernetes-mcp-server v0.0.67 on kind (see dashboard.test.ts).
const fixture = (name: string) =>
  readFileSync(new URL(`../test-fixtures/dashboard/${name}`, import.meta.url), 'utf8');

const panel = (
  id: string,
  view: PanelResult['view'],
  results: { target: string | null; data?: PanelData; error?: string }[],
): PanelResult => ({ id, title: id, view, results });

const kube = (...panels: PanelResult[]): DashboardResult => ({
  updatedAt: '2026-10-22T05:30:00Z',
  connectors: [{ id: 'kubernetes', displayName: 'Kubernetes', panels }],
});

const pods = (name: string) => parseView({ kind: 'pods' }, fixture(name)) as PanelData;
const deployments = (name: string) =>
  parseView({ kind: 'deployments' }, fixture(name)) as PanelData;
const events = (name: string) => parseView({ kind: 'events' }, fixture(name)) as PanelData;

const runs = (
  list: { name: string | null; ref: string; state: 'passed' | 'failed'; at: string }[],
): PanelData => ({
  kind: 'runs',
  counts: { passed: 0, failed: 0, running: 0, other: 0 },
  recent: [],
  full: false,
  runs: list.map((r, i) => ({
    id: String(i),
    url: null,
    status: r.state === 'failed' ? 'failure' : 'success',
    ...r,
  })),
});

describe('check rules', () => {
  it('finds failing, pending, and not-ready pods; clean when all run', () => {
    const found = dashboardFindings(
      kube(panel('pods', 'pods', [{ target: 'dev', data: pods('kubernetes-pods.txt') }])),
    );
    expect(found.findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', 'Pod broken-b4c5b6f66-kvwxv is Error (6 restarts)'],
      ['critical', 'Pod badimage-6f6d479d4c-pjhpd is ImagePullBackOff'],
    ]);
    expect(found.findings[0]).toMatchObject({ check: 'pods', where: 'dev' });
    expect(found.ran).toEqual(['pods']);
    const clean = dashboardFindings(
      kube(panel('pods', 'pods', [{ target: 'dev', data: pods('kubernetes-pods-empty.txt') }])),
    );
    expect(clean.findings).toEqual([]);
    expect(clean.ran).toEqual(['pods']);
  });

  it('finds deployments short of replicas', () => {
    const found = dashboardFindings(
      kube(
        panel('deployments', 'deployments', [
          { target: 'dev', data: deployments('kubernetes-deployments.txt') },
        ]),
      ),
    );
    expect(found.findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', 'Deployment badimage has 0 of 1 replicas ready'],
      ['critical', 'Deployment broken has 0 of 1 replicas ready'],
    ]);
    expect(
      dashboardFindings(
        kube(
          panel('deployments', 'deployments', [
            { target: 'dev', data: deployments('kubernetes-deployments-empty.txt') },
          ]),
        ),
      ).findings,
    ).toEqual([]);
  });

  it('lists warning events, and none when there are none', () => {
    const found = dashboardFindings(
      kube(panel('warnings', 'events', [{ target: 'dev', data: events('kubernetes-events.txt') }])),
    );
    expect(found.findings.length).toBeGreaterThan(0);
    expect(found.findings.every((f) => f.check === 'warnings' && f.severity === 'warning')).toBe(
      true,
    );
    expect(
      dashboardFindings(
        kube(
          panel('warnings', 'events', [
            { target: 'dev', data: events('kubernetes-events-empty.txt') },
          ]),
        ),
      ).findings,
    ).toEqual([]);
  });

  it('calls a pipeline failing when its latest run on the default branch failed', () => {
    const result = (data: PanelData, defaultBranch?: string) =>
      dashboardFindings(
        {
          updatedAt: '',
          connectors: [
            {
              id: 'github-actions',
              displayName: 'GitHub Actions',
              panels: [panel('runs', 'runs', [{ target: 'acme/api', data }])],
            },
          ],
        },
        { defaultBranch: () => defaultBranch },
      ).findings.map((f) => f.title);
    const history = runs([
      { name: 'CI', ref: 'main', state: 'passed', at: '2026-10-21T08:00:00Z' },
      { name: 'CI', ref: 'main', state: 'failed', at: '2026-10-22T08:00:00Z' },
      { name: 'Deploy', ref: 'main', state: 'failed', at: '2026-10-21T08:00:00Z' },
      { name: 'Deploy', ref: 'main', state: 'passed', at: '2026-10-22T08:00:00Z' },
      { name: 'CI', ref: 'feature/x', state: 'failed', at: '2026-10-22T09:00:00Z' },
    ]);
    expect(result(history)).toEqual(['CI on main is failing (failure)']);
    // A known default branch replaces the main/master guess.
    expect(result(history, 'develop')).toEqual([]);
    expect(
      result(
        runs([{ name: null, ref: 'develop', state: 'failed', at: '2026-10-22T08:00:00Z' }]),
        'develop',
      ),
    ).toEqual(['The pipeline on develop is failing (failure)']);
  });

  it('reports databases that are down or degraded, not healthy ones', () => {
    const db = (state: 'ok' | 'degraded' | 'down', reasons: string[] = []): PanelData => ({
      kind: 'database',
      name: 'orders',
      engine: 'postgresql',
      via: 'direct',
      state,
      reasons,
      version: null,
      uptimeSeconds: null,
      connections: null,
      readOnly: null,
      replicaLagSeconds: null,
      latencyMs: null,
    });
    const titles = (data: PanelData) =>
      dashboardFindings(
        kube(panel('databases', 'database', [{ target: 'orders', data }])),
      ).findings.map((f) => [f.severity, f.title]);
    expect(titles(db('down'))).toEqual([['critical', 'Database orders is down']]);
    expect(titles(db('degraded', ['92% of connections used']))).toEqual([
      ['warning', 'Database orders is degraded: 92% of connections used'],
    ]);
    expect(titles(db('ok'))).toEqual([]);
  });

  it('turns an unreadable card into a gap, not a finding', () => {
    const found = dashboardFindings(
      kube(panel('pods', 'pods', [{ target: 'dev', error: 'forbidden' }])),
    );
    expect(found).toEqual({
      findings: [],
      gaps: [{ check: 'pods', where: 'dev', reason: 'forbidden' }],
      ran: [],
    });
  });

  it('lists firing alerts by severity', () => {
    expect(
      alertFindings([
        {
          fingerprint: 'fp1',
          name: 'PodCrashLooping',
          severity: 'critical',
          labels: { namespace: 'payments' },
          annotations: { summary: 'web-1 keeps restarting' },
          startsAt: '',
        },
        {
          fingerprint: 'fp2',
          name: 'DiskFilling',
          severity: 'warning',
          labels: {},
          annotations: {},
          startsAt: '',
        },
      ]),
    ).toEqual([
      {
        id: 'alert:fp1',
        check: 'alerts',
        severity: 'critical',
        title: 'PodCrashLooping: web-1 keeps restarting',
        where: 'payments',
      },
      {
        id: 'alert:fp2',
        check: 'alerts',
        severity: 'warning',
        title: 'DiskFilling',
        where: 'alerts',
      },
    ]);
  });

  it("checks the agent's audit log, budget, and open approvals", () => {
    const chain = (ok: boolean): ChainCheck => ({
      ok,
      records: 3,
      unchained: 0,
      head: null,
      problem: ok ? null : 'record 3 does not match the record before it: one of them was edited',
    });
    expect(agentFindings({ chain: chain(true), budget: null, pendingApprovals: 0 })).toEqual([]);
    const found = agentFindings({
      chain: chain(false),
      budget: { month: '2026-10', limit: 50, spent: 42, over: false },
      pendingApprovals: 2,
    });
    expect(found.map((f) => [f.severity, f.title])).toEqual([
      [
        'critical',
        'The audit log failed its check: record 3 does not match the record before it: one of them was edited',
      ],
      ['warning', 'About $42.00 of the $50.00 monthly budget is used'],
      ['warning', '2 approval requests waiting for an answer'],
    ]);
    expect(
      agentFindings({
        chain: chain(true),
        budget: { month: '2026-10', limit: 50, spent: 30, over: false },
        pendingApprovals: 0,
      }),
    ).toEqual([]);
  });
});

describe('ChecksState', () => {
  const base = (at: string, ran: ('pods' | 'agent')[] = ['pods', 'agent']) => ({
    at,
    trigger: 'morning',
    gaps: [],
    ran,
    skipped: [],
    auditHead: null,
  });
  const crash = {
    id: 'kubernetes:pods:dev:broken',
    check: 'pods' as const,
    severity: 'critical' as const,
    title: 'Pod broken is Error',
    where: 'dev',
  };

  it('calls a problem new, then ongoing, then fixed, and keeps that across a restart', async () => {
    const dir = await tempDir();
    const state = new ChecksState(join(dir, 'audit.jsonl'));
    await state.load();
    const first = state.diff([crash], base('2026-10-22T05:30:00Z'), true);
    expect([first.fresh.length, first.ongoing.length, first.resolved.length]).toEqual([1, 0, 0]);
    state.markRun('morning', '2026-10-22');
    await state.save();

    const again = new ChecksState(join(dir, 'audit.jsonl'));
    await again.load();
    expect(again.lastRun('morning')).toBe('2026-10-22');
    const second = again.diff([crash], base('2026-10-23T05:30:00Z'), true);
    expect(second.ongoing).toEqual([{ ...crash, since: '2026-10-22T05:30:00Z' }]);
    const third = again.diff([], base('2026-10-24T05:30:00Z'), true);
    expect(third.resolved).toEqual([crash]);
    expect(again.diff([], base('2026-10-25T05:30:00Z'), true).resolved).toEqual([]);
  });

  it('keeps a problem open when its check could not run, instead of calling it fixed', () => {
    const state = new ChecksState('/nowhere/audit.jsonl');
    state.diff([crash], base('2026-10-22T05:30:00Z'), true);
    const blind = state.diff(
      [],
      {
        ...base('2026-10-23T05:30:00Z'),
        gaps: [{ check: 'pods', where: 'dev', reason: 'timeout' }],
      },
      true,
    );
    expect(blind.resolved).toEqual([]);
    const off = state.diff([], base('2026-10-24T05:30:00Z', ['agent']), true);
    expect(off.resolved).toEqual([]);
    // Once it can look again and the pod is fine, it is fixed.
    expect(state.diff([], base('2026-10-25T05:30:00Z'), true).resolved).toEqual([crash]);
  });

  it('changes nothing when not committed (a dry run)', () => {
    const state = new ChecksState('/nowhere/audit.jsonl');
    state.diff([crash], base('2026-10-22T05:30:00Z'), false);
    expect(state.latest).toBeNull();
    expect(state.diff([crash], base('2026-10-22T05:31:00Z'), false).fresh).toHaveLength(1);
  });
});

describe('digestText', () => {
  it('says so when everything is fine', () => {
    const d = new ChecksState('/nowhere/a.jsonl').diff(
      [],
      {
        at: '2026-10-22T05:30:00.000Z',
        trigger: 'morning',
        gaps: [],
        ran: ['pods', 'agent'],
        skipped: ['jobs'],
        auditHead: { seq: 41, hash: 'ab'.repeat(32) },
      },
      false,
    );
    expect(isClean(d)).toBe(true);
    expect(digestText(d)).toBe(
      [
        '*Checks* (morning, 2026-10-22 05:30 UTC): everything checked is fine.',
        '',
        'Checked: pods, the agent.\nNot checked (connector off or nothing listed): jobs.\nAudit log head: #41 abababababababab.',
      ].join('\n'),
    );
  });
});

describe('CheckRunner', () => {
  async function setup(opts: { quietWhenClean?: boolean; broken?: boolean } = {}) {
    const dir = await tempDir();
    const auditPath = join(dir, 'audit.jsonl');
    const redactor = new Redactor();
    const audit = new AuditLog(auditPath, redactor);
    const state = new ChecksState(auditPath);
    let now = new Date('2026-10-22T05:00:00Z');
    let broken = opts.broken ?? true;
    const posted: string[] = [];
    const runner = new CheckRunner({
      dashboard: () =>
        Promise.resolve(
          kube(
            panel('pods', 'pods', [
              {
                target: 'dev',
                data: pods(broken ? 'kubernetes-pods.txt' : 'kubernetes-pods-empty.txt'),
              },
            ]),
          ),
        ),
      self: () =>
        Promise.resolve({
          chain: {
            ok: true,
            records: 1,
            unchained: 0,
            head: { seq: 1, hash: 'f'.repeat(64) },
            problem: null,
          },
          budget: null,
          pendingApprovals: 0,
        }),
      state,
      audit,
      redactor,
      post: (text) => {
        posted.push(text);
        return Promise.resolve();
      },
      schedules: [{ name: 'morning', at: '08:30', days: ['thu', 'fri'], timezone: 'Asia/Amman' }],
      quietWhenClean: opts.quietWhenClean ?? false,
      now: () => now,
    });
    return {
      runner,
      posted,
      auditPath,
      setNow: (iso: string) => {
        now = new Date(iso);
      },
      fix: () => {
        broken = false;
      },
    };
  }

  it('posts on schedule once a day, then tells new from ongoing from fixed', async () => {
    const s = await setup();
    await s.runner.tick();
    expect(s.posted).toEqual([]);
    s.setNow('2026-10-22T05:30:00Z');
    await s.runner.tick();
    await s.runner.tick();
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]).toContain('2 new, 0 still broken, 0 fixed.');
    expect(s.posted[0]).toContain(
      '• [critical] Pod broken-b4c5b6f66-kvwxv is Error (6 restarts) (dev)',
    );

    s.setNow('2026-10-23T05:31:00Z');
    await s.runner.tick();
    expect(s.posted[1]).toContain('0 new, 2 still broken, 0 fixed.');
    expect(s.posted[1]).toContain('since 2026-10-22');

    // Saturday is not a scheduled day; an on-demand run still works and is not posted.
    s.fix();
    s.setNow('2026-10-24T05:30:00Z');
    await s.runner.tick();
    expect(s.posted).toHaveLength(2);
    const manual = await s.runner.run('run by console:admin', { post: false, commit: true });
    expect(manual.resolved).toHaveLength(2);
    expect(s.runner.latest?.trigger).toBe('run by console:admin');

    const audit = (await readFile(s.auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(audit.filter((r) => r.event === 'task.start').map((r) => [r.actor, r.detail])).toEqual([
      ['checks', 'morning'],
      ['checks', 'morning'],
      ['checks', 'run by console:admin'],
    ]);
    expect(audit.at(-1)?.detail).toBe('0 new, 0 ongoing, 2 resolved, 0 not checked; not posted');
  });

  it('stays quiet when clean if asked to', async () => {
    const s = await setup({ quietWhenClean: true, broken: false });
    s.setNow('2026-10-22T05:30:00Z');
    await s.runner.tick();
    expect(s.posted).toEqual([]);
    const audit = await readFile(s.auditPath, 'utf8');
    expect(audit).toContain('clean, not posted');
  });
});
