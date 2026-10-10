import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  get,
  pauseAgent,
  resumeAgent,
  SignedOut,
  type ApprovalView,
  type AuditRecord,
  type ConnectorView,
  type Investigation,
  type OverviewView,
  type PendingApproval,
  type UsageTotals,
  type UsageView,
} from './api.ts';
import { ApprovalCard } from './approval.tsx';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { useLoad } from './load.ts';
import { useStatus } from './status.ts';
import { Badge, Cell, Ltr, Page, Table } from './ui.tsx';

/** Who is signed in: `console` (the shared token) or `console:<name>`. */
export interface Me {
  user: string;
  canApprove: boolean;
}

export interface PageProps {
  onSignedOut: () => void;
  me: Me;
}

function uptime(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  const d = Math.floor(seconds / 86_400);
  if (d > 0) return t('overview.days', { d, h });
  if (h > 0) return t('overview.hours', { h, m });
  return t('overview.minutes', { n: Math.max(m, 0) });
}

export function OverviewPage({ onSignedOut, me }: PageProps) {
  const { t, has, num, time } = useI18n();
  const { status, pending, refresh } = useStatus();
  const load = useCallback(() => get<OverviewView>('overview'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  const paused = status?.paused ?? null;
  const budget = status?.budget;
  const money = (n: number) => num(n, { style: 'currency', currency: 'USD' });
  const spentShare =
    budget?.limit && budget.spent !== null ? Math.min(1, budget.spent / budget.limit) : null;

  const toggle = () => {
    (paused ? resumeAgent() : pauseAgent()).then(refresh).catch((e: unknown) => {
      if (e instanceof SignedOut) onSignedOut();
    });
  };

  return (
    <Page
      title="overview.title"
      onRefresh={() => {
        reload();
        refresh();
      }}
      loading={loading}
      error={error}
    >
      {status && (
        <div className="flex flex-col gap-6">
          <p className="-mt-4 text-ink-secondary">
            <Ltr>{status.model}</Ltr> · {t('overview.version')} <Ltr>{status.version}</Ltr> ·{' '}
            {t('overview.uptime')} {uptime(status.uptimeSeconds, t)}
          </p>

          <section
            aria-labelledby="state-title"
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-raised p-5 shadow-sm"
          >
            <div className="flex min-w-0 items-start gap-3.5">
              <span
                aria-hidden="true"
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg ${
                  paused ? 'bg-bad-tint text-bad-text' : 'bg-ok-tint text-ok-text'
                }`}
              >
                <Icon name={paused ? 'pause' : 'activity'} size={20} />
              </span>
              <div>
                <h2 id="state-title" className="text-lg font-semibold">
                  {t(paused ? 'pause.pausedTitle' : 'overview.running')}
                </h2>
                <p className="text-ink-secondary">
                  {paused
                    ? t('pause.pausedBy', { who: paused.by, time: time(paused.at) })
                    : t('overview.runningText')}
                </p>
              </div>
            </div>
            {(!paused || me.canApprove) && (
              <button
                type="button"
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 font-semibold ${
                  paused
                    ? 'bg-primary text-white shadow-md hover:bg-primary-deep'
                    : 'border border-bad-text bg-raised text-bad-text hover:bg-bad-tint'
                }`}
                onClick={toggle}
              >
                <Icon name={paused ? 'activity' : 'pause'} size={16} />
                {t(paused ? 'pause.resume' : 'pause.pauseAll')}
              </button>
            )}
          </section>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
            <Tile label={t('overview.approvalsWaiting')} value={num(pending)}>
              {pending > 0 ? t('overview.review') : t('approvals.noneWaiting')}
            </Tile>
            <Tile
              label={t('overview.investigationsToday')}
              value={num(data?.investigationsToday ?? 0)}
            >
              {data?.lastInvestigation ? (
                <>
                  <Ltr>{data.lastInvestigation.alert}</Ltr>, {time(data.lastInvestigation.ts)}
                </>
              ) : (
                t('investigations.empty')
              )}
            </Tile>
            <Tile
              label={t('overview.changesThisWeek')}
              value={num(
                (data?.changesThisWeek.approved ?? 0) +
                  (data?.changesThisWeek.denied ?? 0) +
                  (data?.changesThisWeek.expired ?? 0),
              )}
            >
              {t('overview.changesSplit', {
                approved: data?.changesThisWeek.approved ?? 0,
                denied: data?.changesThisWeek.denied ?? 0,
              })}
            </Tile>
            <Tile
              label={t('overview.spendThisMonth')}
              value={budget?.spent == null ? t('overview.noPrice') : money(budget.spent)}
              suffix={
                budget?.limit ? t('overview.ofBudget', { limit: money(budget.limit) }) : undefined
              }
            >
              {spentShare !== null ? (
                <span className="flex flex-col gap-1.5">
                  <span
                    role="progressbar"
                    aria-label={t('overview.budgetUsed')}
                    aria-valuenow={Math.round(spentShare * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="block h-2 overflow-hidden rounded-full bg-muted"
                  >
                    <Bar share={spentShare} over={budget?.over === true} />
                  </span>
                  {t(budget?.over ? 'overview.budgetOver' : 'overview.budgetShare', {
                    share: Math.round(spentShare * 100),
                  })}
                </span>
              ) : (
                t('overview.noBudget')
              )}
            </Tile>
          </div>

          <div className="flex flex-wrap items-start gap-5">
            <section
              aria-labelledby="changes-title"
              className="min-w-0 flex-[999_1_420px] rounded-xl border border-line bg-raised p-5"
            >
              <h2 id="changes-title" className="text-lg font-semibold">
                {t('overview.recentChanges')}
              </h2>
              {data && data.recentChanges.length === 0 ? (
                <p className="mt-3 text-ink-secondary">{t('approvals.empty')}</p>
              ) : (
                <ol className="mt-2 flex flex-col">
                  {data?.recentChanges.map((c) => {
                    const decisionKey = `decision.${c.decision ?? ''}`;
                    return (
                      <li
                        key={c.id}
                        className="flex gap-3 border-t border-line py-3 first:border-t-0"
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-1.5 size-2 shrink-0 rounded-full ${
                            c.decision === 'approved' ? 'bg-ok' : 'bg-bad-text'
                          }`}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium">
                            {c.title ? (
                              <bdi dir="auto">{c.title}</bdi>
                            ) : (
                              <Ltr>{`${c.connector}/${c.tool}`}</Ltr>
                            )}
                          </span>
                          <span className="text-[13px] text-ink-secondary">
                            {t('approvals.decided', {
                              decision: has(decisionKey) ? t(decisionKey) : (c.decision ?? ''),
                              who: c.decidedBy ?? '',
                            })}{' '}
                            · {time(c.decidedAt ?? c.ts)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <section
              aria-labelledby="health-title"
              className="min-w-0 flex-[1_1_300px] rounded-xl border border-line bg-raised p-5"
            >
              <h2 id="health-title" className="text-lg font-semibold">
                {t('overview.connectors')}
              </h2>
              <ul className="mt-3 flex flex-col gap-2.5">
                {status.connectors.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span>{c.name}</span>
                    <Badge tone={c.available ? 'ok' : 'plain'}>
                      {t(c.available ? 'overview.available' : 'overview.unavailable')}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </Page>
  );
}

function Tile({
  label,
  value,
  suffix,
  children,
}: {
  label: string;
  value: string;
  suffix?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-raised px-4.5 py-4">
      <span className="text-[13px] font-medium text-ink-secondary">{label}</span>
      <span className="text-3xl font-bold">
        {value}
        {suffix && <span className="ms-1.5 text-sm font-medium text-ink-secondary">{suffix}</span>}
      </span>
      <span className="text-[13px] text-ink-secondary">{children}</span>
    </div>
  );
}

/** The budget bar's fill; its width is set through the DOM (the CSP allows no inline styles). */
function Bar({ share, over }: { share: number; over: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = `${String(Math.round(share * 100))}%`;
  }, [share]);
  return <span ref={ref} className={`block h-2 ${over ? 'bg-bad-text' : 'bg-primary'}`} />;
}

/** A connector's tools. A limit every tool shares is shown once, not on each tool. */
export function ConnectorTools({ connector: c }: { connector: ConnectorView }) {
  const { t, has } = useI18n();
  if (c.tools.length === 0) {
    const note =
      c.category === 'build'
        ? 'connectors.usedByShip'
        : c.category === 'chat'
          ? 'connectors.usedForChat'
          : 'connectors.noTools';
    return <p className="mt-3 text-sm text-ink-secondary">{t(note)}</p>;
  }
  const [first, ...rest] = c.tools;
  const shared = (first?.limits ?? []).filter((l) => rest.every((tool) => tool.limits.includes(l)));
  return (
    <>
      <h3 className="mt-3 text-sm font-semibold">{t('connectors.tools')}</h3>
      {shared.length > 0 && (
        <p className="mt-1 text-sm">
          <span className="text-ink-secondary">{t('connectors.sharedLimits')}</span>{' '}
          <bdi dir="ltr">{shared.join('; ')}</bdi>
        </p>
      )}
      <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {c.tools.map((tool) => {
          const risk = `risk.${tool.risk}`;
          const own = tool.limits.filter((l) => !shared.includes(l));
          return (
            <li key={tool.name}>
              <Ltr>{tool.name}</Ltr>{' '}
              <span className="text-ink-secondary">({has(risk) ? t(risk) : tool.risk})</span>
              {own.length > 0 && (
                <span className="block ps-4 text-xs text-ink-secondary" dir="ltr">
                  {own.join('; ')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const EVENTS = [
  'task.start',
  'model.call',
  'tool.call',
  'approval.request',
  'approval.decision',
  'result',
  'error',
  'control',
];
const DECISIONS = ['allowed', 'approved', 'denied', 'blocked', 'expired'];

export function ActivityPage({ onSignedOut }: PageProps) {
  const { t, has, time } = useI18n();
  const [filters, setFilters] = useState({ event: '', decision: '', connector: '', q: '' });
  const [older, setOlder] = useState<AuditRecord[]>([]);
  const load = useCallback(
    () => get<AuditRecord[]>('activity', { ...filters, limit: '100' }),
    [filters],
  );
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  useEffect(() => {
    setOlder([]);
  }, [filters]);
  const rows = [...(data ?? []), ...older];
  const connectors = [...new Set(rows.map((r) => r.connector).filter(Boolean))] as string[];

  const loadOlder = () => {
    const last = rows.at(-1);
    if (!last) return;
    get<AuditRecord[]>('activity', { ...filters, limit: '100', before: last.ts })
      .then((more) => {
        setOlder((o) => [...o, ...more]);
      })
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
      });
  };

  const label = (prefix: string, value: string) => {
    const key = `${prefix}.${value}`;
    return has(key) ? t(key) : value;
  };

  const select = (name: 'event' | 'decision' | 'connector', options: string[], prefix?: string) => (
    <label className="text-sm">
      <span className="block font-semibold">{t(`activity.${name}`)}</span>
      <select
        className="mt-1 rounded-md border border-line bg-raised px-2 py-1.5"
        value={filters[name]}
        onChange={(e) => {
          setFilters((f) => ({ ...f, [name]: e.target.value }));
        }}
      >
        <option value="">{t('activity.any')}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {prefix ? label(prefix, o) : o}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Page
      title="activity.title"
      intro="activity.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        {select('event', EVENTS, 'event')}
        {select('decision', DECISIONS, 'decision')}
        {select('connector', connectors)}
        <label className="text-sm">
          <span className="block font-semibold">{t('activity.search')}</span>
          <input
            type="search"
            className="mt-1 rounded-md border border-line px-2 py-1.5"
            value={filters.q}
            onChange={(e) => {
              setFilters((f) => ({ ...f, q: e.target.value }));
            }}
          />
        </label>
      </form>
      {data && rows.length === 0 ? (
        <p>{t('activity.empty')}</p>
      ) : (
        <Table
          head={[
            t('activity.time'),
            t('activity.event'),
            t('activity.actor'),
            t('activity.what'),
            t('activity.decision'),
            t('activity.detail'),
          ]}
        >
          {rows.map((r, i) => (
            <tr key={`${r.ts}-${String(i)}`}>
              <Cell>{time(r.ts)}</Cell>
              <Cell>{label('event', r.event)}</Cell>
              <Cell>
                <Ltr>{r.actor}</Ltr>
              </Cell>
              <Cell>{r.connector ? <Ltr>{`${r.connector}/${r.tool ?? ''}`}</Ltr> : null}</Cell>
              <Cell>
                {r.decision ? <Badge tone="plain">{label('decision', r.decision)}</Badge> : null}
              </Cell>
              <Cell mono>
                <bdi dir="ltr">{r.detail}</bdi>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
      {data && data.length === 100 && (
        <button
          type="button"
          onClick={loadOlder}
          className="mt-4 h-9 rounded-lg border border-line-strong bg-raised px-3 text-sm font-medium hover:bg-muted"
        >
          {t('activity.more')}
        </button>
      )}
    </Page>
  );
}

export function InvestigationsPage({ onSignedOut }: PageProps) {
  const { t, time } = useI18n();
  const load = useCallback(() => get<Investigation[]>('investigations'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  return (
    <Page
      title="investigations.title"
      intro="investigations.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      {data?.length === 0 && <p>{t('investigations.empty')}</p>}
      <div className="space-y-4">
        {data?.map((inv, i) => (
          <article
            key={`${inv.ts}-${String(i)}`}
            className="rounded-xl border border-line bg-raised p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">
                <Ltr>{inv.alert}</Ltr>
              </h2>
              <span className="text-sm text-ink-secondary">
                <Badge tone="plain">
                  <bdi dir="ltr">{inv.severity}</bdi>
                </Badge>{' '}
                {time(inv.ts)}
              </span>
            </div>
            {inv.summary && (
              <p className="mt-1 text-sm" dir="ltr">
                {inv.summary}
              </p>
            )}
            <h3 className="mt-3 text-sm font-semibold">{t('investigations.findings')}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm" dir="auto">
              {inv.findings}
            </p>
          </article>
        ))}
      </div>
    </Page>
  );
}

export function UsagePage({ onSignedOut }: PageProps) {
  const { t, num, time } = useI18n();
  const load = useCallback(() => get<UsageView>('usage'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  const cost = (c: number | null) =>
    c === null ? '' : num(c, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  const row = (key: ReactNode, u: UsageTotals) => (
    <>
      <Cell>{key}</Cell>
      <Cell>{num(u.calls)}</Cell>
      <Cell>{num(u.input)}</Cell>
      <Cell>{num(u.cacheRead)}</Cell>
      <Cell>{num(u.output)}</Cell>
      {data?.pricing && <Cell>{cost(u.cost)}</Cell>}
    </>
  );
  const head = (first: MessageKey) => [
    t(first),
    t('usage.calls'),
    t('usage.input'),
    t('usage.cached'),
    t('usage.output'),
    ...(data?.pricing ? [t('usage.cost')] : []),
  ];
  return (
    <Page
      title="usage.title"
      intro="usage.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      {data && (
        <div className="space-y-6">
          <div className="rounded-xl border border-line bg-raised p-4 text-sm">
            <p>
              <Ltr>{data.model}</Ltr>
            </p>
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
              {(
                [
                  ['usage.calls', num(data.totals.calls)],
                  ['usage.input', num(data.totals.input)],
                  ['usage.cached', num(data.totals.cacheRead)],
                  ['usage.output', num(data.totals.output)],
                  ...(data.pricing && data.totals.cost !== null
                    ? [['usage.cost', cost(data.totals.cost)]]
                    : []),
                ] as [MessageKey, string][]
              ).map(([key, value]) => (
                <div key={key} className="flex gap-1">
                  <dt className="text-ink-secondary">{t(key)}:</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {data.totals.input > 0 && (
              <p className="mt-1 text-ink-secondary">
                {t('usage.cacheRate', {
                  rate: num(data.totals.cacheRead / data.totals.input, { style: 'percent' }),
                })}
              </p>
            )}
            <p className="mt-1 text-ink-secondary">
              {data.pricing === null
                ? t('usage.noPrice', { model: data.model })
                : data.pricing.overridden
                  ? t('usage.priceOverride')
                  : t('usage.priceSource', {
                      source: data.model.split('/')[0] ?? '',
                      date: data.pricing.asOf ?? '',
                    })}
            </p>
          </div>
          {data.totals.calls === 0 ? (
            <p>{t('usage.empty')}</p>
          ) : (
            <>
              <section>
                <h2 className="mb-2 font-bold">{t('usage.byDay')}</h2>
                <Table head={head('usage.day')}>
                  {data.days.map((d) => (
                    <tr key={d.day}>{row(<bdi dir="ltr">{d.day}</bdi>, d)}</tr>
                  ))}
                </Table>
              </section>
              <section>
                <h2 className="mb-2 font-bold">{t('usage.byQuestion')}</h2>
                <Table head={head('usage.question')}>
                  {data.questions.map((q) => (
                    <tr key={q.task}>
                      {row(
                        <>
                          {time(q.ts)}{' '}
                          <span className="text-ink-secondary">
                            <Ltr>{q.actor}</Ltr>
                          </span>
                        </>,
                        q,
                      )}
                    </tr>
                  ))}
                </Table>
              </section>
            </>
          )}
        </div>
      )}
    </Page>
  );
}

const PENDING_POLL_MS = 5_000;

export function ApprovalsPage({ onSignedOut, me }: PageProps) {
  const { t, has, time } = useI18n();
  const [tab, setTab] = useState<'waiting' | 'history'>('waiting');
  const load = useCallback(() => get<ApprovalView[]>('approvals'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  const loadPending = useCallback(() => get<PendingApproval[]>('approvals/pending'), []);
  const pending = useLoad(loadPending, onSignedOut);
  const reloadPending = pending.reload;
  useEffect(() => {
    const timer = setInterval(reloadPending, PENDING_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reloadPending]);
  const refresh = () => {
    reload();
    reloadPending();
  };
  const tabClass = (on: boolean) =>
    `h-8 rounded-full px-3.5 text-sm ${
      on ? 'bg-raised font-semibold text-ink shadow-sm' : 'font-medium text-ink-secondary'
    }`;

  return (
    <Page
      title="approvals.title"
      intro="approvals.intro"
      onRefresh={refresh}
      loading={loading}
      error={error ?? pending.error}
    >
      <div
        role="tablist"
        aria-label={t('approvals.title')}
        className="mb-5 inline-flex rounded-full border border-line bg-muted p-0.5"
      >
        <button
          type="button"
          role="tab"
          id="tab-waiting"
          aria-selected={tab === 'waiting'}
          aria-controls="panel-waiting"
          className={tabClass(tab === 'waiting')}
          onClick={() => {
            setTab('waiting');
          }}
        >
          {t('approvals.waitingTab', { n: pending.data?.length ?? 0 })}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-history"
          aria-selected={tab === 'history'}
          aria-controls="panel-history"
          className={tabClass(tab === 'history')}
          onClick={() => {
            setTab('history');
          }}
        >
          {t('approvals.historyTitle')}
        </button>
      </div>

      {tab === 'waiting' ? (
        <section id="panel-waiting" role="tabpanel" aria-labelledby="tab-waiting">
          {pending.data?.length === 0 && (
            <p className="text-ink-secondary">{t('approvals.noneWaiting')}</p>
          )}
          <div className="flex flex-col gap-3.5">
            {pending.data?.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                canApprove={me.canApprove}
                onDecided={refresh}
                onSignedOut={onSignedOut}
              />
            ))}
          </div>
        </section>
      ) : (
        <section id="panel-history" role="tabpanel" aria-labelledby="tab-history">
          {data?.length === 0 ? (
            <p className="text-ink-secondary">{t('approvals.empty')}</p>
          ) : (
            <Table
              head={[
                t('approvals.action'),
                t('approvals.by'),
                t('approvals.outcome'),
                t('approvals.asked'),
              ]}
            >
              {data?.map((a) => {
                const key = `decision.${a.decision ?? ''}`;
                const tone =
                  a.decision === null
                    ? 'accent'
                    : a.decision === 'approved'
                      ? 'ok'
                      : a.decision === 'denied'
                        ? 'bad'
                        : 'plain';
                return (
                  <tr key={a.id}>
                    <Cell>
                      <span className="font-medium">
                        {a.title ? (
                          <bdi dir="auto">{a.title}</bdi>
                        ) : (
                          <Ltr>{`${a.connector}/${a.tool}`}</Ltr>
                        )}
                      </span>
                      <br />
                      <bdi dir="ltr" className="font-mono text-xs break-all text-ink-secondary">
                        {a.args}
                      </bdi>
                    </Cell>
                    <Cell>
                      <Ltr>{a.requestedBy}</Ltr>
                    </Cell>
                    <Cell>
                      <Badge tone={tone}>
                        {a.decision === null
                          ? t('approvals.waiting')
                          : t('approvals.decided', {
                              decision: has(key) ? t(key) : a.decision,
                              who: a.decidedBy ?? '',
                            })}
                      </Badge>
                    </Cell>
                    <Cell>{time(a.ts)}</Cell>
                  </tr>
                );
              })}
            </Table>
          )}
        </section>
      )}
    </Page>
  );
}
