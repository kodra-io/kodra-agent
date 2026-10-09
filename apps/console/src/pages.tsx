import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  get,
  SignedOut,
  type ApprovalView,
  type AuditRecord,
  type ConnectorView,
  type Investigation,
  type StatusView,
  type UsageTotals,
  type UsageView,
} from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';

export interface PageProps {
  onSignedOut: () => void;
}

/** Loads one API route; a 401 signs the page out. */
function useLoad<T>(load: () => Promise<T>, onSignedOut: () => void) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof SignedOut) {
          onSignedOut();
          return;
        }
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        }));
      });
    return () => {
      alive = false;
    };
  }, [load, nonce, onSignedOut]);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setNonce((n) => n + 1);
  }, []);
  return { ...state, reload };
}

function Page({
  title,
  intro,
  onRefresh,
  loading,
  error,
  children,
}: {
  title: MessageKey;
  intro?: MessageKey;
  onRefresh: () => void;
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="page-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="page-title" className="text-2xl font-bold">
            {t(title)}
          </h1>
          {intro && <p className="mt-1 text-sm text-ink-secondary">{t(intro)}</p>}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-primary-tint"
        >
          {t('app.refresh')}
        </button>
      </div>
      <div className="mt-6" aria-busy={loading}>
        {error && (
          <p role="alert" className="rounded-md border border-line bg-white p-3">
            {t('app.error', { message: error })}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

function Badge({ tone, children }: { tone: 'accent' | 'plain'; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
        tone === 'accent'
          ? 'bg-primary-tint text-primary-deep'
          : 'border border-line bg-white text-ink'
      }`}
    >
      {children}
    </span>
  );
}

function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full text-start text-sm">
        <thead className="bg-surface text-ink-secondary">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 text-start font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

const Cell = ({ children, mono }: { children: ReactNode; mono?: boolean }) => (
  <td className={`px-3 py-2 align-top ${mono ? 'font-mono text-xs break-all' : ''}`}>{children}</td>
);

/** Technical values (names, ids, arguments) read left to right in both languages. */
const Ltr = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="font-mono text-xs">
    {children}
  </bdi>
);

function uptime(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  const d = Math.floor(seconds / 86_400);
  if (d > 0) return t('overview.days', { d, h });
  if (h > 0) return t('overview.hours', { h, m });
  return t('overview.minutes', { n: Math.max(m, 0) });
}

export function OverviewPage({ onSignedOut }: PageProps) {
  const { t } = useI18n();
  const load = useCallback(() => get<StatusView>('status'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  return (
    <Page title="overview.title" onRefresh={reload} loading={loading} error={error}>
      {data && (
        <div className="grid gap-6 md:grid-cols-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-line bg-white p-4 text-sm">
            <dt className="text-ink-secondary">{t('overview.model')}</dt>
            <dd>
              <Ltr>{data.model}</Ltr>
            </dd>
            <dt className="text-ink-secondary">{t('overview.version')}</dt>
            <dd>
              <Ltr>{data.version}</Ltr>
            </dd>
            <dt className="text-ink-secondary">{t('overview.target')}</dt>
            <dd>
              <Ltr>{data.target}</Ltr>
            </dd>
            <dt className="text-ink-secondary">{t('overview.uptime')}</dt>
            <dd>{uptime(data.uptimeSeconds, t)}</dd>
            <dt className="text-ink-secondary">{t('overview.slack')}</dt>
            <dd>{t(data.slack ? 'overview.on' : 'overview.off')}</dd>
            <dt className="text-ink-secondary">{t('overview.monitoring')}</dt>
            <dd>{t(data.monitoring ? 'overview.on' : 'overview.off')}</dd>
          </dl>
          <div className="rounded-lg border border-line bg-white p-4">
            <h2 className="font-bold">{t('overview.connectors')}</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {data.connectors.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span>{c.name}</span>
                  <Badge tone={c.available ? 'accent' : 'plain'}>
                    {t(c.available ? 'overview.available' : 'overview.unavailable')}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Page>
  );
}

export function ConnectorsPage({ onSignedOut }: PageProps) {
  const { t, has } = useI18n();
  const load = useCallback(() => get<ConnectorView[]>('connectors'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  return (
    <Page title="connectors.title" onRefresh={reload} loading={loading} error={error}>
      <div className="space-y-4">
        {data?.map((c) => (
          <article key={c.id} className="rounded-lg border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold">{c.name}</h2>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-ink-secondary">{t('connectors.access')}:</span>
                <Ltr>{c.access ?? t('connectors.on')}</Ltr>
                <Badge tone={c.available ? 'accent' : 'plain'}>
                  {t(c.available ? 'overview.available' : 'overview.unavailable')}
                </Badge>
              </div>
            </div>
            {!c.available && (
              <dl className="mt-3 space-y-1 text-sm">
                <dt className="font-semibold">{t('connectors.reason')}</dt>
                <dd>
                  <Ltr>{c.reason}</Ltr>
                </dd>
                <dt className="font-semibold">{t('connectors.fix')}</dt>
                <dd>{c.hint}</dd>
              </dl>
            )}
            {c.available && (
              <>
                <h3 className="mt-3 text-sm font-semibold">{t('connectors.tools')}</h3>
                {c.tools.length === 0 ? (
                  <p className="text-sm text-ink-secondary">{t('connectors.noTools')}</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-sm">
                    {c.tools.map((tool) => {
                      const risk = `risk.${tool.risk}`;
                      return (
                        <li key={tool.name}>
                          <Ltr>{tool.name}</Ltr>{' '}
                          <span className="text-ink-secondary">
                            ({has(risk) ? t(risk) : tool.risk})
                          </span>
                          {tool.limits.length > 0 && (
                            <span className="block ps-4 text-xs text-ink-secondary" dir="ltr">
                              {tool.limits.join('; ')}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </article>
        ))}
      </div>
    </Page>
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
        className="mt-1 rounded-md border border-line bg-white px-2 py-1.5"
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
          className="mt-4 rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-primary-tint"
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
            className="rounded-lg border border-line bg-white p-4"
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
          <div className="rounded-lg border border-line bg-white p-4 text-sm">
            <p>
              <Ltr>{data.model}</Ltr>
            </p>
            <p className="mt-1">
              {num(data.totals.input)} {t('usage.input')}, {num(data.totals.output)}{' '}
              {t('usage.output')}
              {data.pricing && data.totals.cost !== null && (
                <>
                  {', '}
                  {t('usage.cost')}: <strong>{cost(data.totals.cost)}</strong>
                </>
              )}
            </p>
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

export function ApprovalsPage({ onSignedOut }: PageProps) {
  const { t, has, time } = useI18n();
  const load = useCallback(() => get<ApprovalView[]>('approvals'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  return (
    <Page
      title="approvals.title"
      intro="approvals.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      {data?.length === 0 ? (
        <p>{t('approvals.empty')}</p>
      ) : (
        <Table
          head={[
            t('approvals.asked'),
            t('approvals.by'),
            t('approvals.action'),
            t('approvals.args'),
            t('approvals.outcome'),
          ]}
        >
          {data?.map((a) => {
            const key = `decision.${a.decision ?? ''}`;
            return (
              <tr key={a.id}>
                <Cell>{time(a.ts)}</Cell>
                <Cell>
                  <Ltr>{a.requestedBy}</Ltr>
                </Cell>
                <Cell>
                  <Ltr>{`${a.connector}/${a.tool}`}</Ltr>
                </Cell>
                <Cell mono>
                  <bdi dir="ltr">{a.args}</bdi>
                </Cell>
                <Cell>
                  {a.decision === null ? (
                    <Badge tone="plain">{t('approvals.waiting')}</Badge>
                  ) : (
                    <Badge tone={a.decision === 'approved' ? 'accent' : 'plain'}>
                      {t('approvals.decided', {
                        decision: has(key) ? t(key) : a.decision,
                        who: a.decidedBy ?? '',
                      })}
                    </Badge>
                  )}
                </Cell>
              </tr>
            );
          })}
        </Table>
      )}
    </Page>
  );
}
