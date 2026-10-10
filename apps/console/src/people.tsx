import { useCallback, useState } from 'react';
import {
  ApiError,
  get,
  post,
  SignedOut,
  type PeopleView,
  type PersonView,
  type StatusView,
} from './api.ts';
import { useI18n } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { useLoad } from './load.ts';
import { useStatus } from './status.ts';
import { Badge, Ltr } from './ui.tsx';

const RESTART_TIMEOUT_MS = 90_000;

const input = 'h-10 w-full rounded-lg border border-line-strong bg-surface px-3';
const primary =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-white shadow-md hover:bg-primary-deep disabled:opacity-50';
const secondary =
  'inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-raised px-3 font-medium hover:bg-muted disabled:opacity-50';
const danger =
  'inline-flex h-9 items-center gap-2 rounded-lg bg-bad-text px-3 font-semibold text-white disabled:opacity-50';

type Restart = 'waiting' | 'back' | 'signedOut' | 'slow';

/**
 * Waits for the agent to come back with a new start time. A rotated token of your own signs
 * you out when it comes back, which also means it is back.
 */
async function waitForRestart(oldStart: string | undefined): Promise<Restart> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    try {
      const status = await get<StatusView>('status');
      if (status.startedAt !== oldStart) return 'back';
    } catch (e) {
      if (e instanceof SignedOut) return 'signedOut';
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'slow';
}

/** The "People and tokens" tab of Settings, for console approvers. */
export function PeoplePanel({
  me,
  onSignedOut,
  onRestarted,
}: {
  me: string | undefined;
  onSignedOut: () => void;
  onRestarted: () => void;
}) {
  const { t, time } = useI18n();
  const { status } = useStatus();
  const load = useCallback(() => get<PeopleView>('people'), []);
  const { data: view, error, reload } = useLoad(load, onSignedOut);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'rotate' | 'remove'; who: string } | null>(null);
  // The token, shown once: it stays on screen while the agent restarts, until Done.
  const [shown, setShown] = useState<{ who: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [restart, setRestart] = useState<Restart | null>(null);

  const run = async (
    action: string,
    body: Record<string, string>,
    who: string | null,
  ): Promise<void> => {
    setBusy(true);
    // The start time before the change: the agent may restart before we look again.
    const startedAt = status?.startedAt;
    setProblem(null);
    let result: { token?: string; restarting?: boolean };
    try {
      result = await post<{ token?: string; restarting?: boolean }>(action, body);
    } catch (e) {
      setBusy(false);
      if (e instanceof SignedOut) onSignedOut();
      else setProblem(e instanceof ApiError ? e.message : String(e));
      return;
    }
    setConfirm(null);
    setName('');
    if (result.token && who) {
      setShown({ who, token: result.token });
      setCopied(false);
    }
    if (result.restarting) {
      setRestart('waiting');
      const outcome = await waitForRestart(startedAt);
      setRestart(outcome);
      if (outcome === 'back') {
        onRestarted();
        reload();
      }
    } else reload();
    setBusy(false);
  };

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const done = () => {
    setShown(null);
    if (restart === 'signedOut') onSignedOut();
    setRestart(null);
  };

  const label = (p: PersonView) => (p.who === 'console' ? t('people.shared') : p.who);

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p role="alert" className="rounded-lg border border-line bg-bad-tint p-3 text-bad-text">
          {t('app.error', { message: error })}
        </p>
      )}
      {view && !view.editable && (
        <p className="rounded-xl border border-line bg-raised p-4">{t('people.kubernetes')}</p>
      )}

      {shown && (
        <div
          role="region"
          aria-labelledby="token-title"
          className="flex flex-col gap-3 rounded-xl border border-primary bg-primary-tint p-5"
        >
          <h2 id="token-title" className="flex items-center gap-2 text-lg font-semibold">
            <Icon name="key" size={18} />
            {t('people.tokenTitle', {
              who: shown.who === 'console' ? t('people.shared') : shown.who,
            })}
          </h2>
          <p>{t('people.tokenOnce')}</p>
          <div className="flex flex-wrap gap-2">
            <input
              readOnly
              dir="ltr"
              aria-label={t('people.token')}
              value={shown.token}
              className={`${input} min-w-0 flex-1 font-mono text-sm`}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
            <button type="button" className={primary} onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'copy'} size={16} />
              {copied ? t('people.copied') : t('people.copy')}
            </button>
          </div>
          <p role="status" className="text-sm text-ink-secondary">
            {restart === 'waiting' && t('people.restarting')}
            {restart === 'back' && t('people.back')}
            {restart === 'signedOut' && t('people.signInAgain')}
            {restart === 'slow' && t('settings.notBack')}
          </p>
          <div>
            <button
              type="button"
              className={secondary}
              disabled={restart === 'waiting'}
              onClick={done}
            >
              {t('people.done')}
            </button>
          </div>
        </div>
      )}
      {!shown && restart === 'waiting' && (
        <p role="status" className="flex items-center gap-2 text-ink-secondary">
          <Icon name="spinner" size={18} className="animate-spin" />
          {t('people.restarting')}
        </p>
      )}
      {problem && (
        <p role="alert" className="rounded-lg bg-bad-tint p-3 text-bad-text">
          <bdi dir="ltr">{problem}</bdi>
        </p>
      )}

      <section
        aria-labelledby="people-title"
        className="flex flex-col gap-3 rounded-xl border border-line bg-raised p-5"
      >
        <h2 id="people-title" className="text-base font-semibold">
          {t('people.accounts')}
        </h2>
        <p className="text-sm text-ink-secondary">{t('people.accountsIntro')}</p>
        <ul className="flex flex-col divide-y divide-line">
          {view?.people.map((p) => (
            <li key={p.who} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  <Ltr>{label(p)}</Ltr>
                  <Badge tone={p.canApprove ? 'accent' : 'plain'}>
                    {p.canApprove ? t('people.approver') : t('people.viewer')}
                  </Badge>
                  {p.who === me && <Badge tone="plain">{t('people.you')}</Badge>}
                  {!p.tokenSet && <Badge tone="bad">{t('people.noToken')}</Badge>}
                </span>
                <span className="text-sm text-ink-secondary">
                  <Ltr>{p.envVar}</Ltr>
                </span>
              </div>
              {view.editable &&
                (confirm?.who === p.who ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {confirm.action === 'rotate'
                        ? t(p.who === me ? 'people.rotateConfirmSelf' : 'people.rotateConfirm')
                        : t('people.removeConfirm')}
                    </span>
                    <button
                      type="button"
                      className={confirm.action === 'remove' ? danger : primary}
                      disabled={busy}
                      onClick={() => void run(`people/${confirm.action}`, { who: p.who }, p.who)}
                    >
                      {confirm.action === 'rotate' ? t('people.rotate') : t('people.remove')}
                    </button>
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => {
                        setConfirm(null);
                      }}
                    >
                      {t('approval.cancel')}
                    </button>
                  </span>
                ) : (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className={secondary}
                      disabled={busy}
                      aria-label={t('people.rotateFor', { who: label(p) })}
                      onClick={() => {
                        setConfirm({ action: 'rotate', who: p.who });
                      }}
                    >
                      {t('people.rotate')}
                    </button>
                    {p.canApprove && (
                      <button
                        type="button"
                        className={secondary}
                        disabled={busy}
                        aria-label={t('people.removeFor', { who: label(p) })}
                        onClick={() => {
                          setConfirm({ action: 'remove', who: p.who });
                        }}
                      >
                        {t('people.remove')}
                      </button>
                    )}
                  </span>
                ))}
            </li>
          ))}
        </ul>
        {view && view.otherApprovers.length > 0 && (
          <p className="text-sm text-ink-secondary">
            {t('people.others')} <Ltr>{view.otherApprovers.join(', ')}</Ltr>
          </p>
        )}
        {view?.editable && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const clean = name.trim().replace(/^console:/, '');
              if (clean) void run('people/add', { name: clean }, `console:${clean}`);
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="font-medium">{t('people.addLabel')}</span>
              <span className="flex items-center gap-1" dir="ltr">
                <span className="text-ink-secondary">console:</span>
                <input
                  className={input}
                  value={name}
                  placeholder="on-call"
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              </span>
              <span className="text-sm text-ink-secondary">{t('people.addHint')}</span>
            </label>
            <button type="submit" className={primary} disabled={busy || name.trim() === ''}>
              <Icon name="plus" size={16} />
              {t('people.add')}
            </button>
          </form>
        )}
      </section>

      <section
        aria-labelledby="sessions-title"
        className="flex flex-col gap-3 rounded-xl border border-line bg-raised p-5"
      >
        <h2 id="sessions-title" className="text-base font-semibold">
          {t('people.sessions')}
        </h2>
        <p className="text-sm text-ink-secondary">{t('people.sessionsIntro')}</p>
        {view && view.sessions.length === 0 && (
          <p className="text-ink-secondary">{t('people.noSessions')}</p>
        )}
        {view && view.sessions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="text-ink-secondary">
                  <th className="py-2 text-start font-medium">{t('people.who')}</th>
                  <th className="py-2 text-start font-medium">{t('people.since')}</th>
                  <th className="py-2 text-start font-medium">{t('people.lastSeen')}</th>
                  <th className="py-2">
                    <span className="sr-only">{t('people.signOut')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2">
                      <Ltr>{s.user === 'console' ? t('people.shared') : s.user}</Ltr>
                    </td>
                    <td className="py-2">{time(s.since)}</td>
                    <td className="py-2">{time(s.lastSeen)}</td>
                    <td className="py-2 text-end">
                      <button
                        type="button"
                        className={secondary}
                        disabled={busy}
                        onClick={() => void run('people/sign-out', { id: s.id }, null)}
                      >
                        {t('people.signOut')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
