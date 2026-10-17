import { useCallback, useEffect, type ReactNode } from 'react';
import {
  get,
  type DashboardView,
  type DeploymentsData,
  type EventsData,
  type PanelResult,
  type PodsData,
  type RunsData,
  type RunState,
  type TargetResult,
} from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { useLoad } from './load.ts';
import type { PageProps } from './pages.tsx';
import { Badge, Ltr, Page } from './ui.tsx';

/** How often the open page asks again; the agent refreshes at most once a minute anyway. */
const REFRESH_MS = 60_000;

const RUN_TONE = { passed: 'ok', failed: 'bad', running: 'accent', other: 'plain' } as const;

/** Every result of one kind, across a card's targets. */
function dataOf<K extends 'pods' | 'deployments' | 'events' | 'runs'>(
  view: DashboardView,
  kind: K,
) {
  type D = Extract<PodsData | DeploymentsData | EventsData | RunsData, { kind: K }>;
  return view.connectors
    .flatMap((c) => c.panels)
    .flatMap((p) => p.results)
    .map((r) => r.data)
    .filter((d): d is D => d?.kind === kind);
}

export function DashboardPage({ onSignedOut }: PageProps) {
  const { t, time } = useI18n();
  const load = useCallback(() => get<DashboardView>('dashboard'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);

  return (
    <Page
      title="dashboard.title"
      intro="dashboard.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      {data && (
        <div className="flex flex-col gap-8">
          <p className="-mt-3 text-sm text-ink-secondary">
            {t('dashboard.updated', { time: time(data.updatedAt) })}
          </p>
          {data.connectors.length === 0 ? (
            <p className="rounded-xl border border-line bg-raised p-5">{t('dashboard.none')}</p>
          ) : (
            <>
              <Headline view={data} />
              {data.connectors.map((c) => (
                <section
                  key={c.id}
                  aria-labelledby={`dash-${c.id}`}
                  className="flex flex-col gap-4"
                >
                  <h2 id={`dash-${c.id}`} className="text-xl font-semibold">
                    {c.displayName}
                  </h2>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {c.panels.map((p) => (
                      <PanelCard key={p.id} panel={p} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </Page>
  );
}

/** The numbers worth a glance: pods, deployments, and pipelines. */
function Headline({ view }: { view: DashboardView }) {
  const { t, num } = useI18n();
  const pods = dataOf(view, 'pods');
  const deployments = dataOf(view, 'deployments');
  const runs = dataOf(view, 'runs');
  const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((n, x) => n + f(x), 0);
  const tiles: { label: MessageKey; value: string; tone: 'ok' | 'bad' | 'plain' }[] = [];
  if (pods.length > 0) {
    const failing = sum(pods, (p) => p.counts.failing);
    tiles.push({
      label: 'dashboard.tile.podsRunning',
      value: num(sum(pods, (p) => p.counts.running)),
      tone: 'ok',
    });
    tiles.push({
      label: 'dashboard.tile.podsFailing',
      value: num(failing),
      tone: failing > 0 ? 'bad' : 'plain',
    });
  }
  if (deployments.length > 0) {
    const ready = sum(deployments, (d) => d.ready);
    const total = sum(deployments, (d) => d.total);
    tiles.push({
      label: 'dashboard.tile.deploymentsReady',
      value: t('dashboard.ofTotal', { n: num(ready), total: num(total) }),
      tone: ready < total ? 'bad' : 'ok',
    });
  }
  if (runs.length > 0) {
    const failed = sum(runs, (r) => r.counts.failed);
    tiles.push({
      label: 'dashboard.tile.runsFailed',
      value: num(failed),
      tone: failed > 0 ? 'bad' : 'plain',
    });
    tiles.push({
      label: 'dashboard.tile.runsRunning',
      value: num(sum(runs, (r) => r.counts.running)),
      tone: 'plain',
    });
  }
  if (tiles.length === 0) return null;
  const color = { ok: 'text-ok-text', bad: 'text-bad-text', plain: 'text-ink' };
  return (
    <ul
      aria-label={t('dashboard.summary')}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {tiles.map((tile) => (
        <li key={tile.label} className="rounded-xl border border-line bg-raised p-4 shadow-sm">
          <p className="text-sm text-ink-secondary">{t(tile.label)}</p>
          <p className={`mt-1 text-2xl font-bold ${color[tile.tone]}`}>{tile.value}</p>
        </li>
      ))}
    </ul>
  );
}

function PanelCard({ panel }: { panel: PanelResult }) {
  const { t, lang } = useI18n();
  const title = panel.title[lang];
  return (
    <article
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-raised p-5 shadow-sm"
    >
      <h3 className="font-semibold">{title}</h3>
      {panel.note && (
        <p className="text-sm text-ink-secondary">
          {t(panel.note === 'no-targets' ? 'dashboard.noTargets' : 'dashboard.unavailable')}
        </p>
      )}
      {panel.view === 'pods' && <Pods results={panel.results} />}
      {panel.view === 'deployments' && <Deployments results={panel.results} />}
      {panel.view === 'events' && <Events results={panel.results} />}
      {panel.view === 'runs' && <Runs results={panel.results} />}
    </article>
  );
}

/** Targets that failed, each with its reason. */
function Errors({ results }: { results: TargetResult[] }) {
  const { t } = useI18n();
  const failed = results.filter((r) => r.error);
  if (failed.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {failed.map((r) => (
        <li key={r.target ?? ''} className="text-bad-text">
          {r.target && (
            <>
              <Ltr>{r.target}</Ltr>:{' '}
            </>
          )}
          {t('dashboard.couldNotRead')} <span className="text-ink-secondary">({r.error})</span>
        </li>
      ))}
    </ul>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y divide-line text-sm">{children}</ul>;
}

function Pods({ results }: { results: TargetResult[] }) {
  const { t, num } = useI18n();
  const list = results.map((r) => r.data).filter((d): d is PodsData => d?.kind === 'pods');
  const counts = { running: 0, pending: 0, failing: 0, completed: 0 };
  for (const d of list)
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += d.counts[k];
  const pods = list.flatMap((d) => d.pods).slice(0, 8);
  return (
    <>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Badge tone="ok">{t('dashboard.pods.running', { n: num(counts.running) })}</Badge>
          <Badge tone={counts.failing > 0 ? 'bad' : 'plain'}>
            {t('dashboard.pods.failing', { n: num(counts.failing) })}
          </Badge>
          <Badge tone="plain">{t('dashboard.pods.pending', { n: num(counts.pending) })}</Badge>
          {counts.completed > 0 && (
            <Badge tone="plain">
              {t('dashboard.pods.completed', { n: num(counts.completed) })}
            </Badge>
          )}
        </div>
      )}
      {pods.length > 0 ? (
        <Rows>
          {pods.map((p) => (
            <li
              key={`${p.namespace}/${p.name}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0">
                <Ltr>{p.name}</Ltr>{' '}
                <span className="text-ink-secondary">
                  · <Ltr>{p.namespace}</Ltr>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={p.status === 'Running' ? 'plain' : 'bad'}>{p.status}</Badge>
                {p.restarts > 0 && (
                  <span className="text-ink-secondary">
                    {t('dashboard.pods.restarts', { n: num(p.restarts) })}
                  </span>
                )}
              </span>
            </li>
          ))}
        </Rows>
      ) : (
        list.length > 0 && (
          <p className="text-sm text-ink-secondary">{t('dashboard.pods.allGood')}</p>
        )
      )}
      <Errors results={results} />
    </>
  );
}

function Deployments({ results }: { results: TargetResult[] }) {
  const { t, num } = useI18n();
  const list = results
    .map((r) => r.data)
    .filter((d): d is DeploymentsData => d?.kind === 'deployments');
  const ready = list.reduce((n, d) => n + d.ready, 0);
  const total = list.reduce((n, d) => n + d.total, 0);
  const rows = list.flatMap((d) => d.deployments).slice(0, 10);
  return (
    <>
      {list.length > 0 && (
        <>
          <p className="text-sm">
            {t('dashboard.deployments.ready', { n: num(ready), total: num(total) })}
          </p>
          {total > 0 && (
            <div
              role="progressbar"
              aria-label={t('dashboard.deployments.bar')}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={ready}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-ok-text"
                style={{ width: `${String((ready / total) * 100)}%` }}
              />
            </div>
          )}
        </>
      )}
      {rows.length > 0 && (
        <Rows>
          {rows.map((d) => {
            const ok = d.ready >= d.desired;
            return (
              <li
                key={`${d.namespace}/${d.name}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0">
                  <Ltr>{d.name}</Ltr>{' '}
                  <span className="text-ink-secondary">
                    · <Ltr>{d.namespace}</Ltr>
                  </span>
                </span>
                <Badge tone={ok ? 'ok' : 'bad'}>
                  {t(ok ? 'dashboard.deployments.okRow' : 'dashboard.deployments.badRow', {
                    n: num(d.ready),
                    total: num(d.desired),
                  })}
                </Badge>
              </li>
            );
          })}
        </Rows>
      )}
      <Errors results={results} />
    </>
  );
}

function Events({ results }: { results: TargetResult[] }) {
  const { t, num } = useI18n();
  const list = results.map((r) => r.data).filter((d): d is EventsData => d?.kind === 'events');
  const warnings = list.flatMap((d) => d.warnings).slice(0, 8);
  return (
    <>
      {list.length > 0 && warnings.length === 0 && (
        <p className="text-sm text-ink-secondary">{t('dashboard.events.none')}</p>
      )}
      {warnings.length > 0 && (
        <Rows>
          {warnings.map((w) => (
            <li key={`${w.reason} ${w.object}`} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone="bad">{w.reason}</Badge>
                <Ltr>{w.object}</Ltr>
                {w.count > 1 && (
                  <span className="text-ink-secondary">
                    {t('dashboard.events.times', { n: num(w.count) })}
                  </span>
                )}
              </span>
              <span className="break-words text-ink-secondary">{w.message}</span>
            </li>
          ))}
        </Rows>
      )}
      <Errors results={results} />
    </>
  );
}

function Runs({ results }: { results: TargetResult[] }) {
  const { t, num, time } = useI18n();
  const state = (s: RunState): MessageKey => `dashboard.run.${s}`;
  return (
    <>
      {results
        .filter((r) => r.data?.kind === 'runs')
        .map((r) => {
          const d = r.data as RunsData;
          const finished = d.counts.passed + d.counts.failed;
          return (
            <div key={r.target ?? ''} className="flex flex-col gap-2">
              {r.target && (
                <p className="text-sm font-medium">
                  <Ltr>{r.target}</Ltr>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="ok">{t('dashboard.runs.passed', { n: num(d.counts.passed) })}</Badge>
                <Badge tone={d.counts.failed > 0 ? 'bad' : 'plain'}>
                  {t('dashboard.runs.failed', { n: num(d.counts.failed) })}
                </Badge>
                <Badge tone="accent">
                  {t('dashboard.runs.running', { n: num(d.counts.running) })}
                </Badge>
                {finished > 0 && (
                  <span className="text-sm text-ink-secondary">
                    {t('dashboard.runs.rate', {
                      rate: num(d.counts.passed / finished, { style: 'percent' }),
                    })}
                  </span>
                )}
              </div>
              {d.runs.length === 0 ? (
                <p className="text-sm text-ink-secondary">{t('dashboard.runs.none')}</p>
              ) : (
                <Rows>
                  {d.runs.map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge tone={RUN_TONE[run.state]}>{t(state(run.state))}</Badge>
                        {run.name && <span>{run.name}</span>}
                        <Ltr>{run.ref}</Ltr>
                      </span>
                      <span className="flex items-center gap-3 text-ink-secondary">
                        {Number.isNaN(Date.parse(run.at)) ? <Ltr>{run.at}</Ltr> : time(run.at)}
                        {run.url && (
                          <a
                            href={run.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-text underline underline-offset-2"
                            aria-label={t('dashboard.runs.openLabel', { id: run.id })}
                          >
                            {t('dashboard.runs.open')}
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </Rows>
              )}
            </div>
          );
        })}
      <Errors results={results} />
    </>
  );
}
