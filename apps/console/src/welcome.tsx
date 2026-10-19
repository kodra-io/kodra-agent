import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DashboardView, OverviewView, StatusView } from './api.ts';
import { get } from './api.ts';
import { askInChat } from './ask.ts';
import {
  briefing,
  greetingFor,
  nameOf,
  systemsOf,
  totalsOf,
  type Posture,
  type Severity,
  type SystemState,
} from './briefing.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Ltr } from './ui.tsx';

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

const POSTURE: Record<Posture, { label: MessageKey; className: string; dot: string }> = {
  nominal: {
    label: 'welcome.posture.nominal',
    className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
    dot: 'bg-emerald-400',
  },
  degraded: {
    label: 'welcome.posture.degraded',
    className: 'border-amber-300/40 bg-amber-300/10 text-amber-200',
    dot: 'bg-amber-300',
  },
  critical: {
    label: 'welcome.posture.critical',
    className: 'border-red-400/50 bg-red-500/15 text-red-200',
    dot: 'bg-red-400',
  },
};

const SEVERITY: Record<Severity, string> = {
  critical: 'border-red-400/50 bg-red-500/15 text-red-200',
  action: 'border-sky-400/50 bg-sky-400/10 text-sky-200',
  warning: 'border-amber-300/40 bg-amber-300/10 text-amber-200',
  info: 'border-slate-400/40 bg-slate-400/10 text-slate-200',
};

const LIGHT: Record<SystemState['state'], { dot: string; text: string; label: MessageKey }> = {
  ok: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'welcome.state.ok' },
  warn: { dot: 'bg-amber-300', text: 'text-amber-200', label: 'welcome.state.warn' },
  down: { dot: 'bg-red-400', text: 'text-red-300', label: 'welcome.state.down' },
};

/**
 * The top of the Overview page, laid out like an operations center: a live clock and the
 * overall posture, key numbers, the attention queue, and a light per connected system.
 * Built from the agent's status, its records, and the dashboard's read tools. Never the model.
 */
export function Welcome({
  user,
  status,
  pending,
  overview,
  uptime,
  go,
  chat,
}: {
  user: string;
  status: StatusView;
  pending: number;
  overview: OverviewView | null;
  uptime: string;
  go: (path: string) => void;
  chat: boolean;
}) {
  const { t, lang, num, time } = useI18n();
  const now = useClock();
  const [dashboard, setDashboard] = useState<DashboardView | null>(null);

  // The dashboard's cards are optional here: without them the board has less to say.
  const loadDashboard = useCallback(() => {
    get<DashboardView>('dashboard')
      .then(setDashboard)
      .catch(() => {
        setDashboard(null);
      });
  }, []);
  useEffect(loadDashboard, [loadDashboard, status]);

  const locale = lang === 'ar' ? 'ar-u-nu-latn' : 'en';
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const greeting = t(greetingFor(now.getHours()));
  const name = nameOf(user);
  const { posture, attention, total } = briefing({ status, pending, overview, dashboard });
  const totals = totalsOf(dashboard);
  const systems = systemsOf(status, dashboard);
  const budget = status.budget;
  const money = (n: number) => num(n, { style: 'currency', currency: 'USD' });
  const spentShare =
    budget?.limit && budget.spent !== null ? Math.min(1, budget.spent / budget.limit) : null;
  const changes = overview?.changesThisWeek;
  const p = POSTURE[posture];

  return (
    <section
      aria-labelledby="welcome-title"
      className="kodra-ops relative isolate overflow-hidden rounded-2xl border border-slate-700/60 text-slate-100 shadow-2xl"
    >
      {/* Header: who, the posture, and the clock. */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-700/60 px-5 py-5 md:px-7">
        <div className="min-w-0">
          <p className="flex items-center gap-2.5 text-xs font-semibold tracking-[0.2em] text-sky-300 uppercase">
            <span className="inline-flex items-center gap-1.5 rounded border border-red-400/50 bg-red-500/15 px-1.5 py-0.5 tracking-widest text-red-200">
              <span aria-hidden="true" className="kodra-live size-1.5 rounded-full bg-red-400" />
              {t('welcome.live')}
            </span>
            {t('welcome.opsTitle')}
          </p>
          <h2 id="welcome-title" className="mt-2 text-2xl font-bold md:text-3xl">
            {name ? t('welcome.greetingName', { greeting, name }) : greeting}
          </h2>
          <p className="mt-1 text-sm text-slate-300">{date}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <time
            dateTime={now.toISOString()}
            className="font-mono text-4xl font-semibold tracking-wider text-white tabular-nums md:text-5xl"
            dir="ltr"
          >
            {clock}
          </time>
          <span
            className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-bold tracking-widest uppercase ${p.className}`}
          >
            <span aria-hidden="true" className={`kodra-live size-2 rounded-full ${p.dot}`} />
            {t(p.label)}
          </span>
        </div>
      </div>

      {/* Key numbers. */}
      <ul
        aria-label={t('welcome.kpis')}
        className="flex flex-wrap gap-px border-b border-slate-700/60 bg-slate-700/60"
      >
        <Kpi
          label={t('overview.approvalsWaiting')}
          value={num(pending)}
          tone={pending > 0 ? 'action' : 'plain'}
          sub={pending > 0 ? t('overview.review') : t('approvals.noneWaiting')}
        />
        {totals.seen.pods && (
          <Kpi
            label={t('welcome.kpi.pods')}
            value={`${num(totals.podsRunning)}/${num(totals.podsTotal)}`}
            tone={totals.podsFailing > 0 ? 'critical' : 'ok'}
            sub={t('welcome.kpi.podsFailing', { n: totals.podsFailing })}
          />
        )}
        {totals.seen.deployments && (
          <Kpi
            label={t('welcome.kpi.deployments')}
            value={`${num(totals.deploymentsReady)}/${num(totals.deploymentsTotal)}`}
            tone={totals.deploymentsReady < totals.deploymentsTotal ? 'warning' : 'ok'}
          />
        )}
        {totals.seen.runs && (
          <Kpi
            label={t('welcome.kpi.runs')}
            value={num(totals.runsFailed)}
            tone={totals.runsFailed > 0 ? 'warning' : 'ok'}
            sub={t('welcome.kpi.runsSub', {
              passed: totals.runsPassed,
              running: totals.runsRunning,
            })}
          />
        )}
        <Kpi
          label={t('overview.investigationsToday')}
          value={num(overview?.investigationsToday ?? 0)}
          tone="plain"
          sub={
            overview?.lastInvestigation ? (
              <>
                <Ltr>{overview.lastInvestigation.alert}</Ltr>, {time(overview.lastInvestigation.ts)}
              </>
            ) : (
              t('investigations.empty')
            )
          }
        />
        <Kpi
          label={t('overview.changesThisWeek')}
          value={num((changes?.approved ?? 0) + (changes?.denied ?? 0) + (changes?.expired ?? 0))}
          tone="plain"
          sub={t('overview.changesSplit', {
            approved: changes?.approved ?? 0,
            denied: changes?.denied ?? 0,
          })}
        />
        <Kpi
          label={t('overview.spendThisMonth')}
          value={budget?.spent == null ? t('overview.noPrice') : money(budget.spent)}
          tone={budget?.over ? 'critical' : 'plain'}
          sub={
            spentShare !== null && budget?.limit ? (
              <span className="flex flex-col gap-1.5">
                <span>{t('overview.ofBudget', { limit: money(budget.limit) })}</span>
                <span
                  role="progressbar"
                  aria-label={t('overview.budgetUsed')}
                  aria-valuenow={Math.round(spentShare * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="block h-1.5 overflow-hidden rounded-full bg-slate-700"
                >
                  <Fill share={spentShare} over={budget.over} />
                </span>
              </span>
            ) : (
              t('overview.noBudget')
            )
          }
        />
      </ul>

      {/* The queue and the systems board. */}
      <div className="grid gap-px bg-slate-700/60 lg:grid-cols-[3fr_2fr]">
        <section aria-labelledby="queue-title" className="kodra-ops-panel min-w-0 p-5 md:p-6">
          <PanelTitle id="queue-title" count={total}>
            {t('welcome.queue')}
          </PanelTitle>
          {attention.length === 0 ? (
            <p className="mt-4 flex items-center gap-2.5 text-emerald-300">
              <Icon name="check" size={16} />
              {t('welcome.queueEmpty')}
            </p>
          ) : (
            <ol className="mt-3 flex flex-col gap-1.5">
              {attention.map((item) => {
                const row = (
                  <>
                    <span
                      className={`w-[5.5rem] shrink-0 rounded border px-1.5 py-0.5 text-center text-[11px] font-bold tracking-wider uppercase ${SEVERITY[item.severity]}`}
                    >
                      {t(`welcome.sev.${item.severity}`)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <bdi dir="auto">{t(item.key, item.vars)}</bdi>
                    </span>
                    {item.to && (
                      <Icon
                        name="chevronRight"
                        size={16}
                        className="shrink-0 text-slate-400 group-hover:text-white rtl:-scale-x-100"
                      />
                    )}
                  </>
                );
                const rowClass =
                  'flex items-center gap-3 rounded-lg border border-slate-700/70 bg-slate-900/50 px-3 py-2.5';
                return (
                  <li key={item.key}>
                    {item.to ? (
                      <a
                        href={item.to}
                        className={`group ${rowClass} hover:border-slate-500 hover:bg-slate-800/70`}
                        onClick={(e) => {
                          e.preventDefault();
                          if (item.to) go(item.to);
                        }}
                      >
                        {row}
                      </a>
                    ) : (
                      <div className={rowClass}>{row}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {total > attention.length && (
            <p className="mt-2 text-sm text-slate-300">
              {t('welcome.more', { n: total - attention.length })}
            </p>
          )}
        </section>

        <section aria-labelledby="systems-title" className="kodra-ops-panel min-w-0 p-5 md:p-6">
          <PanelTitle id="systems-title" count={systems.length}>
            {t('welcome.systems')}
          </PanelTitle>
          <ul className="mt-3 flex flex-col divide-y divide-slate-700/60">
            {systems.map((s) => {
              const light = LIGHT[s.state];
              return (
                <li key={s.id} className="flex items-center gap-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={`size-2.5 shrink-0 rounded-full ${light.dot} ${s.state === 'ok' ? '' : 'kodra-live'}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-xs text-slate-300">{t(s.metric.key, s.metric.vars)}</span>
                  </span>
                  <span className={`text-xs font-bold tracking-widest uppercase ${light.text}`}>
                    {t(light.label)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* Status line. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/60 px-5 py-3.5 md:px-7">
        <p className="font-mono text-xs text-slate-300">
          <Ltr>{status.model}</Ltr> · <Ltr>{`v${status.version}`}</Ltr> · {t('overview.uptime')}{' '}
          {uptime}
          {overview?.auditHead && (
            <>
              {' '}
              · {t('welcome.audit', { seq: overview.auditHead.seq })}{' '}
              <bdi dir="ltr" title={overview.auditHead.hash}>
                {overview.auditHead.hash.slice(0, 12)}
              </bdi>
            </>
          )}
          {dashboard && <> · {t('welcome.updated', { time: time(dashboard.updatedAt) })}</>}
        </p>
        {chat && (
          <a
            href="/chat"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-sky-400/60 bg-sky-400/10 px-3.5 text-sm font-semibold text-sky-100 hover:bg-sky-400/20"
            onClick={(e) => {
              e.preventDefault();
              askInChat(t('welcome.briefingPrompt'));
              go('/chat');
            }}
          >
            <Icon name="chat" size={15} />
            {t('welcome.briefing')}
          </a>
        )}
      </div>
    </section>
  );
}

function PanelTitle({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="flex items-center gap-2 text-xs font-bold tracking-[0.18em] text-slate-300 uppercase"
    >
      {children}
      <span className="rounded bg-slate-700/80 px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-slate-100">
        {count}
      </span>
    </h3>
  );
}

const KPI_TONE = {
  plain: 'text-white',
  ok: 'text-emerald-300',
  action: 'text-sky-300',
  warning: 'text-amber-200',
  critical: 'text-red-300',
};

function Kpi({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: keyof typeof KPI_TONE;
  sub?: ReactNode;
}) {
  return (
    <li className="kodra-ops-panel flex min-w-0 flex-[1_1_9.5rem] flex-col gap-1 px-4 py-3.5">
      <span className="text-[11px] font-semibold tracking-wider text-slate-300 uppercase">
        {label}
      </span>
      <span className={`font-mono text-2xl font-semibold tabular-nums ${KPI_TONE[tone]}`}>
        {value}
      </span>
      {sub && <span className="text-xs text-slate-300">{sub}</span>}
    </li>
  );
}

/** The budget bar's fill; its width is set through the DOM (the CSP allows no inline styles). */
function Fill({ share, over }: { share: number; over: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = `${String(Math.round(share * 100))}%`;
  }, [share]);
  return <span ref={ref} className={`block h-1.5 ${over ? 'bg-red-400' : 'bg-sky-400'}`} />;
}
