import { useCallback, useEffect, useState } from 'react';
import type { DashboardView, OverviewView, StatusView } from './api.ts';
import { get } from './api.ts';
import { briefing, greetingFor, headlineFor, nameOf } from './briefing.ts';
import { askInChat } from './ask.ts';
import { useI18n } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Ltr } from './ui.tsx';

/** How often the greeting checks the clock, so morning turns into afternoon on an open page. */
const CLOCK_MS = 60_000;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/**
 * The top of the Overview page: a greeting and what needs someone, built from the agent's
 * status, its records, and the dashboard's read tools. Never the model.
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
  const { t, lang, num } = useI18n();
  const now = useNow();
  const [dashboard, setDashboard] = useState<DashboardView | null>(null);

  // The dashboard's cards are optional here: without them the briefing has less to say.
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
  }).format(now);
  const greeting = t(greetingFor(now.getHours()));
  const name = nameOf(user);
  const { attention, total } = briefing({ status, pending, overview, dashboard });
  const money = (n: number) => num(n, { style: 'currency', currency: 'USD' });
  const ok = status.connectors.filter((c) => c.available).length;
  const budget = status.budget;

  const calm: string[] = [];
  if (status.connectors.length > 0) {
    calm.push(t('welcome.connectorsOk', { ok, total: status.connectors.length }));
  }
  if (budget?.spent != null) {
    calm.push(
      budget.limit
        ? t('welcome.spentOf', { spent: money(budget.spent), limit: money(budget.limit) })
        : t('welcome.spent', { spent: money(budget.spent) }),
    );
  }

  return (
    <section
      aria-labelledby="welcome-title"
      className="kodra-hero relative isolate overflow-hidden rounded-2xl px-6 py-7 text-white shadow-xl md:px-9 md:py-9"
    >
      <div className="kodra-rise flex flex-col gap-6">
        <div>
          <p className="text-sm font-medium tracking-wide text-white/85 uppercase">{date}</p>
          <h2 id="welcome-title" className="mt-1.5 text-3xl font-bold md:text-4xl">
            {name ? t('welcome.greetingName', { greeting, name }) : greeting}
          </h2>
          <p className="mt-2 text-lg text-white/90">{t(headlineFor(total), { n: total })}</p>
        </div>

        {attention.length > 0 && (
          <ul aria-label={t('welcome.summaryLabel')} className="flex flex-col gap-2">
            {attention.map((item) => {
              const text = t(item.key, item.vars);
              const row = (
                <>
                  <span
                    aria-hidden="true"
                    className="kodra-beacon size-2.5 shrink-0 rounded-full bg-white"
                  />
                  <span className="min-w-0 flex-1">
                    <bdi dir="auto">{text}</bdi>
                  </span>
                  {item.to && (
                    <Icon
                      name="chevronRight"
                      size={16}
                      className="shrink-0 opacity-80 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100"
                    />
                  )}
                </>
              );
              const rowClass =
                'flex items-center gap-3 rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm';
              return (
                <li key={item.key}>
                  {item.to ? (
                    <a
                      href={item.to}
                      className={`group ${rowClass} hover:bg-white/20`}
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
          </ul>
        )}
        {total > attention.length && (
          <p className="-mt-3 text-sm text-white/85">
            {t('welcome.more', { n: total - attention.length })}
          </p>
        )}

        {calm.length > 0 && (
          <p className="flex items-center gap-3 text-white/90">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full border-2 border-white/80"
            />
            <span>{calm.join(' · ')}</span>
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/15 pt-5">
          {chat ? (
            <a
              href="/chat"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 font-semibold text-primary-deep shadow-md hover:bg-white/90"
              onClick={(e) => {
                e.preventDefault();
                askInChat(t('welcome.briefingPrompt'));
                go('/chat');
              }}
            >
              <Icon name="chat" size={16} />
              {t('welcome.briefing')}
            </a>
          ) : (
            <span />
          )}
          <p className="text-sm text-white/85">
            <Ltr>{status.model}</Ltr> · {t('overview.version')} <Ltr>{status.version}</Ltr> ·{' '}
            {t('overview.uptime')} {uptime}
          </p>
        </div>
      </div>
    </section>
  );
}
