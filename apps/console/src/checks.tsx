import { useCallback, useEffect, useState } from 'react';
import {
  get,
  runChecks,
  SignedOut,
  type CheckDigest,
  type CheckFinding,
  type ChecksView,
} from './api.ts';
import { askInChat } from './ask.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Badge } from './ui.tsx';

const KINDS = new Set([
  'pods',
  'deployments',
  'warnings',
  'pipelines',
  'jobs',
  'databases',
  'alerts',
  'agent',
]);

/**
 * The latest digest of the read-only checks (M27): what is new, what is still broken, what
 * was fixed, and when they run next. "Run now" runs them here without posting to Slack.
 * Built from the agent's parsed findings, never the model.
 */
export function ChecksCard({
  go,
  chat,
  onSignedOut,
}: {
  go: (path: string) => void;
  chat: boolean;
  onSignedOut: () => void;
}) {
  const { t, time } = useI18n();
  const [view, setView] = useState<ChecksView | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    get<ChecksView>('checks')
      .then((v) => {
        setView(Array.isArray(v.schedules) ? v : null);
      })
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
        setView(null);
      });
  }, [onSignedOut]);
  useEffect(load, [load]);

  if (!view) return null;
  const kind = (check: string) =>
    KINDS.has(check) ? t(`checks.kind.${check}` as MessageKey) : check;
  const run = () => {
    setRunning(true);
    setFailed(false);
    runChecks()
      .then(({ latest }) => {
        setView({ ...view, latest });
      })
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
        else setFailed(true);
      })
      .finally(() => {
        setRunning(false);
      });
  };
  const d = view.latest;

  return (
    <section
      aria-labelledby="checks-title"
      className="rounded-xl border border-line bg-raised p-5 md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="checks-title" className="text-lg font-semibold">
            {t('checks.title')}
          </h2>
          <p className="text-sm text-ink-secondary">
            {view.schedules.length === 0
              ? t('checks.noSchedule')
              : view.schedules
                  .map((s) =>
                    t('checks.schedule', {
                      at: s.at,
                      zone: s.timezone,
                      days: s.days.length === 7 ? t('checks.everyDay') : s.days.join(', '),
                    }),
                  )
                  .join(' ')}
          </p>
          <p className="text-sm text-ink-secondary">
            {d ? t('checks.last', { time: time(d.at), trigger: d.trigger }) : t('checks.never')}
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={run}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-raised px-3.5 text-sm font-semibold hover:bg-muted disabled:opacity-60"
        >
          <Icon name={running ? 'spinner' : 'activity'} size={15} />
          {t(running ? 'checks.running' : 'checks.run')}
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-bad-text">
          {t('checks.runFailed')}
        </p>
      )}
      {d && <DigestBody d={d} kind={kind} chat={chat} go={go} />}
    </section>
  );
}

function DigestBody({
  d,
  kind,
  chat,
  go,
}: {
  d: CheckDigest;
  kind: (check: string) => string;
  chat: boolean;
  go: (path: string) => void;
}) {
  const { t } = useI18n();
  const open = d.fresh.length + d.ongoing.length;
  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className={`font-semibold ${open > 0 ? 'text-warn-text' : 'text-ok-text'}`}>
        {open === 0 && d.gaps.length === 0
          ? t('checks.clean')
          : t('checks.summary', {
              fresh: d.fresh.length,
              ongoing: d.ongoing.length,
              resolved: d.resolved.length,
            })}
      </p>
      <Findings title={t('checks.new')} items={d.fresh} chat={chat} go={go} />
      <Findings title={t('checks.ongoing')} items={d.ongoing} chat={chat} go={go} since />
      <Findings title={t('checks.resolved')} items={d.resolved} chat={false} go={go} />
      {d.gaps.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">{t('checks.gaps')}</h3>
          <ul className="mt-1 list-disc ps-5 text-sm text-ink-secondary">
            {d.gaps.map((g) => (
              <li key={`${g.check}:${g.where}`}>
                {kind(g.check)}, {g.where}: {g.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.skipped.length > 0 && (
        <p className="text-xs text-ink-secondary">
          {t('checks.notChecked', { list: d.skipped.map(kind).join(', ') })}
        </p>
      )}
    </div>
  );
}

function Findings({
  title,
  items,
  chat,
  go,
  since = false,
}: {
  title: string;
  items: CheckFinding[];
  chat: boolean;
  go: (path: string) => void;
  since?: boolean;
}) {
  const { t, time } = useI18n();
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">
        {title} <span className="font-mono text-xs text-ink-secondary">{items.length}</span>
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((f) => (
          <li
            key={f.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2"
          >
            <Badge tone={f.severity === 'critical' ? 'bad' : 'warn'}>
              {t(f.severity === 'critical' ? 'welcome.sev.critical' : 'welcome.sev.warning')}
            </Badge>
            <span className="min-w-0 flex-1 text-sm">
              <span>{f.title}</span>{' '}
              <span className="text-ink-secondary">
                ({f.where}
                {since && f.since ? `, ${t('checks.since', { time: time(f.since) })}` : ''})
              </span>
            </span>
            {f.url?.startsWith('https://') && (
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-semibold text-primary-text hover:underline"
              >
                {t('checks.open')}
              </a>
            )}
            {chat && (
              <button
                type="button"
                aria-label={t('checks.askAbout', { title: f.title })}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-text hover:underline"
                onClick={() => {
                  askInChat(t('checks.askPrompt', { where: f.where, title: f.title }));
                  go('/chat');
                }}
              >
                <Icon name="chat" size={14} />
                {t('checks.ask')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
