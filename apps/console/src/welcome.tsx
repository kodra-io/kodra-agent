import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DashboardView, OverviewView, StatusView } from './api.ts';
import { get } from './api.ts';
import { askInChat } from './ask.ts';
import {
  briefing,
  greetingFor,
  nameOf,
  runsToday,
  systemsOf,
  totalsOf,
  type Posture,
  type Severity,
  type SystemState,
} from './briefing.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Badge, Mono } from './ui.tsx';

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

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Rolls a number up to its value (eased, 0.7 s); with reduced motion it simply shows. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(() => (reducedMotion() ? target : 0));
  const from = useRef(shown);
  useEffect(() => {
    const duration = reducedMotion() ? 0 : 700;
    const start = performance.now();
    const origin = from.current;
    let frame = requestAnimationFrame(function step(at) {
      const k = duration ? Math.min(1, Math.max(0, (at - start) / duration)) : 1;
      const value = k === 1 ? target : origin + (target - origin) * (1 - (1 - k) ** 3);
      from.current = value;
      setShown(value);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target]);
  return shown;
}

function Count({ value, format }: { value: number; format: (n: number) => string }) {
  const shown = useCountUp(value);
  if (shown === value) return format(value);
  return format(Number.isInteger(value) ? Math.round(shown) : shown);
}

type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'plain';

const POSTURE: Record<Posture, { label: MessageKey; tone: Tone; ring: string }> = {
  nominal: { label: 'welcome.posture.nominal', tone: 'ok', ring: 'text-ok' },
  degraded: { label: 'welcome.posture.degraded', tone: 'warn', ring: 'text-warn' },
  critical: { label: 'welcome.posture.critical', tone: 'bad', ring: 'text-bad' },
};

const SEVERITY: Record<Severity, Tone> = {
  critical: 'bad',
  action: 'accent',
  warning: 'warn',
  info: 'plain',
};

const LIGHT: Record<SystemState['state'], { dot: string; tone: Tone; label: MessageKey }> = {
  ok: { dot: 'bg-ok', tone: 'ok', label: 'welcome.state.ok' },
  warn: { dot: 'kodra-beat bg-warn text-warn', tone: 'warn', label: 'welcome.state.warn' },
  down: { dot: 'kodra-beat bg-bad text-bad', tone: 'bad', label: 'welcome.state.down' },
};

/**
 * The top of the Overview page, laid out like an operations center: a live clock in a status
 * ring, key numbers, the attention queue, and a light per connected system. Built from the
 * agent's status, its records, and the dashboard's read tools. Never the model.
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
  const { t, num, time } = useI18n();
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

  const date = new Intl.DateTimeFormat('en', {
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
  const today = runsToday(dashboard, now);
  const dbReady = totals.databases.filter((d) => d.state === 'ok').length;
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
      className="overflow-hidden rounded-xl border border-line bg-raised"
    >
      {/* Header: who, the posture, and the clock in its ring. */}
      <div className="kodra-boot flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4 md:px-6">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-primary-text uppercase">
            <span aria-hidden="true" className="kodra-live size-2 rounded-full bg-ok" />
            {t('welcome.live')}
            <span aria-hidden="true" className="text-line-strong">
              /
            </span>
            {t('welcome.opsTitle')}
          </p>
          <h2 id="welcome-title" className="mt-1.5 text-2xl font-bold md:text-[1.7rem]">
            {name ? t('welcome.greetingName', { greeting, name }) : greeting}
          </h2>
          <p className="mt-0.5 text-sm text-ink-secondary">{date}</p>
        </div>
        <div className="flex items-center gap-4">
          <Badge tone={p.tone}>{t(p.label)}</Badge>
          <div className="relative grid size-32 shrink-0 place-items-center">
            <StatusRing className={p.ring} />
            <time
              dateTime={now.toISOString()}
              className="relative font-mono text-lg font-semibold tabular-nums"
            >
              {clock}
            </time>
          </div>
        </div>
      </div>

      {/* Key numbers. */}
      <ul
        aria-label={t('welcome.kpis')}
        className="kodra-boot kodra-boot-2 grid grid-cols-2 gap-3 border-b md:grid-cols-4 border-line bg-surface p-4 md:px-6"
      >
        <Kpi
          label={t('overview.approvalsWaiting')}
          value={<Count value={pending} format={num} />}
          tone={pending > 0 ? 'action' : 'plain'}
          sub={pending > 0 ? t('overview.review') : t('approvals.noneWaiting')}
        />
        {totals.seen.pods && (
          <Kpi
            label={t('welcome.kpi.pods')}
            value={
              <>
                <Count value={totals.podsRunning} format={num} />/
                <Count value={totals.podsTotal} format={num} />
              </>
            }
            tone={totals.podsFailing > 0 ? 'critical' : 'ok'}
            sub={t('welcome.kpi.podsFailing', { n: totals.podsFailing })}
          />
        )}
        {totals.seen.deployments && (
          <Kpi
            label={t('welcome.kpi.deployments')}
            value={
              <>
                <Count value={totals.deploymentsReady} format={num} />/
                <Count value={totals.deploymentsTotal} format={num} />
              </>
            }
            tone={totals.deploymentsReady < totals.deploymentsTotal ? 'warning' : 'ok'}
          />
        )}
        {today && (
          <Kpi
            label={t('welcome.kpi.today')}
            value={
              <>
                <Count value={today.ran} format={num} />
                {today.atLeast && '+'}
              </>
            }
            tone={today.failed > 0 ? 'warning' : today.ran > 0 ? 'ok' : 'plain'}
            sub={t('welcome.kpi.todaySub', {
              passed: today.passed,
              failed: today.failed,
              running: today.running,
            })}
          />
        )}
        {totals.seen.databases && (
          <Kpi
            label={t('welcome.kpi.databases')}
            value={
              <>
                <Count value={dbReady} format={num} />/
                <Count value={totals.databases.length} format={num} />
              </>
            }
            tone={
              totals.databases.some((d) => d.state === 'down')
                ? 'critical'
                : dbReady < totals.databases.length
                  ? 'warning'
                  : 'ok'
            }
            sub={
              dbReady === totals.databases.length
                ? t('welcome.kpi.databasesOk')
                : t('welcome.kpi.databasesOff', { n: totals.databases.length - dbReady })
            }
          />
        )}
        <Kpi
          label={t('overview.investigationsToday')}
          value={<Count value={overview?.investigationsToday ?? 0} format={num} />}
          tone="plain"
          sub={
            overview?.lastInvestigation ? (
              <>
                <Mono>{overview.lastInvestigation.alert}</Mono>,{' '}
                {time(overview.lastInvestigation.ts)}
              </>
            ) : (
              t('investigations.empty')
            )
          }
        />
        <Kpi
          label={t('overview.changesThisWeek')}
          value={
            <Count
              value={(changes?.approved ?? 0) + (changes?.denied ?? 0) + (changes?.expired ?? 0)}
              format={num}
            />
          }
          tone="plain"
          sub={t('overview.changesSplit', {
            approved: changes?.approved ?? 0,
            denied: changes?.denied ?? 0,
          })}
        />
        <Kpi
          label={t('overview.spendThisMonth')}
          value={
            budget?.spent == null ? (
              t('overview.noPrice')
            ) : (
              <Count value={budget.spent} format={money} />
            )
          }
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
                  className="block h-1.5 overflow-hidden rounded-full bg-muted"
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
      <div className="grid divide-line max-lg:divide-y lg:grid-cols-[3fr_2fr] lg:divide-x">
        <section
          aria-labelledby="queue-title"
          className="kodra-boot kodra-boot-3 min-w-0 p-5 md:p-6"
        >
          <PanelTitle id="queue-title" count={total}>
            {t('welcome.queue')}
          </PanelTitle>
          {attention.length === 0 ? (
            <p className="mt-4 flex items-center gap-2.5 text-ok-text">
              <Icon name="check" size={16} />
              {t('welcome.queueEmpty')}
            </p>
          ) : (
            <ol className="kodra-stagger mt-3 flex flex-col gap-1.5">
              {attention.map((item) => {
                const row = (
                  <>
                    <span className="w-[5.5rem] shrink-0 text-center">
                      <Badge tone={SEVERITY[item.severity]}>
                        {t(`welcome.sev.${item.severity}`)}
                      </Badge>
                    </span>
                    <span className="min-w-0 flex-1 text-sm">
                      <span>{t(item.key, item.vars)}</span>
                    </span>
                    {item.to && (
                      <Icon
                        name="chevronRight"
                        size={16}
                        className="shrink-0 text-ink-secondary group-hover:text-primary-text"
                      />
                    )}
                  </>
                );
                const rowClass =
                  'flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5';
                return (
                  <li key={item.key}>
                    {item.to ? (
                      <a
                        href={item.to}
                        className={`group ${rowClass} hover:border-line-strong hover:bg-muted`}
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
            <p className="mt-2 text-sm text-ink-secondary">
              {t('welcome.more', { n: total - attention.length })}
            </p>
          )}
        </section>

        <section
          aria-labelledby="systems-title"
          className="kodra-boot kodra-boot-3 min-w-0 p-5 md:p-6"
        >
          <PanelTitle id="systems-title" count={systems.length}>
            {t('welcome.systems')}
          </PanelTitle>
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {systems.map((s) => {
              const light = LIGHT[s.state];
              return (
                <li key={s.id} className="flex items-center gap-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={`size-2.5 shrink-0 rounded-full ${light.dot}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">
                      <span>{s.name}</span>
                    </span>
                    <span className="text-xs text-ink-secondary">
                      {t(s.metric.key, s.metric.vars)}
                    </span>
                  </span>
                  <Badge tone={light.tone}>{t(light.label)}</Badge>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* Status line. */}
      <div className="kodra-boot kodra-boot-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-5 py-3 md:px-6">
        <p className="font-mono text-xs text-ink-secondary">
          <Mono>{status.model}</Mono> · <Mono>{`v${status.version}`}</Mono> · {t('overview.uptime')}{' '}
          {uptime}
          {overview?.auditHead && (
            <>
              {' '}
              · {t('welcome.audit', { seq: overview.auditHead.seq })}{' '}
              <span title={overview.auditHead.hash}>{overview.auditHead.hash.slice(0, 12)}</span>
            </>
          )}
          {dashboard && <> · {t('welcome.updated', { time: time(dashboard.updatedAt) })}</>}
        </p>
        {chat && (
          <a
            href="/chat"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-white hover:bg-primary-deep"
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
      className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-ink-secondary uppercase"
    >
      {children}
      <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-ink">
        {count}
      </span>
    </h3>
  );
}

const KPI_TONE = {
  plain: 'text-ink',
  ok: 'text-ok-text',
  action: 'text-primary-text',
  warning: 'text-warn-text',
  critical: 'text-bad-text',
};

function Kpi({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: ReactNode;
  tone: keyof typeof KPI_TONE;
  sub?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-raised px-4 py-3">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${KPI_TONE[tone]}`}>{value}</span>
      {sub && <span className="text-xs text-ink-secondary">{sub}</span>}
    </li>
  );
}

/** The budget bar's fill; its width is set through the DOM (the CSP allows no inline styles). */
function Fill({ share, over }: { share: number; over: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = `${String(Math.round(share * 100))}%`;
  }, [share]);
  return <span ref={ref} className={`block h-1.5 ${over ? 'bg-bad' : 'bg-primary'}`} />;
}

/**
 * The posture as a ring around the clock: a ring that draws itself, a tick scale, and one thin
 * arc turning slowly. Its color (`currentColor`) follows the posture.
 */
function StatusRing({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 120"
      className={`absolute inset-0 size-full ${className}`}
      fill="none"
      stroke="currentColor"
    >
      <circle cx="60" cy="60" r="54" strokeWidth="1.5" opacity="0.15" />
      <circle
        className="kodra-ring-draw"
        cx="60"
        cy="60"
        r="54"
        strokeWidth="3"
        strokeLinecap="round"
        transform="rotate(-90 60 60)"
      />
      <circle cx="60" cy="60" r="47" strokeWidth="2.5" strokeDasharray="0.8 4.1" opacity="0.35" />
      <circle
        className="kodra-spin"
        cx="60"
        cy="60"
        r="58.5"
        strokeWidth="1"
        strokeDasharray="60 307"
        opacity="0.6"
      />
    </svg>
  );
}
