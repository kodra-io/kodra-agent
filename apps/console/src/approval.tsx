import { useId, useState } from 'react';
import { ApiError, decide, SignedOut, type PendingApproval } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Ltr } from './ui.tsx';

type Step = 'ask' | 'confirm' | 'deny' | 'sending' | 'closed';

const button =
  'inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold disabled:opacity-50';
const primary = `${button} bg-primary text-white shadow-md hover:bg-primary-deep`;
const secondary = `${button} border border-line-strong bg-raised text-ink hover:bg-muted`;

/**
 * A change waiting for a decision, in the chat and on the Approvals page. Approving takes a
 * second, explicit step; denying can say why. Only a console approver gets the buttons; the
 * agent checks again anyway.
 */
export function ApprovalCard({
  approval: a,
  canApprove,
  onDecided,
  onSignedOut,
}: {
  approval: Omit<PendingApproval, 'requestedBy'> & { requestedBy?: string };
  canApprove: boolean;
  onDecided: () => void;
  onSignedOut: () => void;
}) {
  const { t, has, time } = useI18n();
  const [step, setStep] = useState<Step>('ask');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  const titleId = useId();
  // A proposed change is named by its title; a single tool call by connector/tool.
  const action = a.title ?? `${a.connector}/${a.tool}`;
  const risk = `risk.${a.risk}`;

  const send = async (approve: boolean) => {
    setStep('sending');
    setProblem(null);
    try {
      await decide(a.id, approve, approve ? undefined : note.trim());
      onDecided();
    } catch (e) {
      if (e instanceof SignedOut) {
        onSignedOut();
        return;
      }
      const key: MessageKey | null =
        e instanceof ApiError && e.status === 409
          ? 'approval.expired'
          : e instanceof ApiError && e.status === 404
            ? 'approval.gone'
            : null;
      setProblem(
        key ? t(key) : t('approval.failed', { message: e instanceof Error ? e.message : '' }),
      );
      // Expired or decided elsewhere: nothing left to click. The next refresh removes it.
      setStep(key ? 'closed' : 'ask');
    }
  };

  return (
    <section
      role="group"
      aria-label={t('approval.needed')}
      aria-describedby={titleId}
      className="overflow-hidden rounded-xl border border-primary bg-raised shadow-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-primary-tint px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon name="shield" className="shrink-0 text-primary-text" />
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-semibold tracking-wide text-primary-text uppercase">
              {t('approval.needed')}
            </span>
            <span id={titleId} className="font-semibold">
              {a.title ? <bdi dir="auto">{a.title}</bdi> : <Ltr>{action}</Ltr>}
            </span>
          </span>
        </div>
        <span className="text-xs text-ink-secondary">
          {has(risk) ? t(risk) : a.risk} · {t('approval.expires', { time: time(a.expiresAt) })}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5 text-sm">
        <p className="text-ink-secondary">
          <span className="font-medium text-ink">{t('approval.why')}:</span>{' '}
          <span dir="auto" className="whitespace-pre-wrap">
            {a.reason}
          </span>
        </p>
        {a.requestedBy && (
          <p className="text-xs text-ink-secondary">
            {t('approvals.by')}: <Ltr>{a.requestedBy}</Ltr>
          </p>
        )}
        {a.preview ? (
          <>
            <p className="text-xs text-ink-secondary">
              <span className="font-medium">{t('approval.steps')}:</span>{' '}
              <bdi dir="ltr" className="font-mono">
                {a.args}
              </bdi>
            </p>
            <Preview text={a.preview} />
          </>
        ) : (
          <div>
            <p className="text-xs font-medium text-ink-secondary">{t('approval.args')}</p>
            <pre
              dir="ltr"
              className="mt-1 overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all"
            >
              {a.args}
            </pre>
          </div>
        )}

        {problem && (
          <p role="alert" className="font-semibold text-bad-text">
            {problem}
          </p>
        )}

        {!canApprove && <p className="text-ink-secondary">{t('approval.cannot')}</p>}

        {canApprove && step === 'ask' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={primary}
              onClick={() => {
                setStep('confirm');
              }}
            >
              {t('approval.approve')}
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => {
                setStep('deny');
              }}
            >
              {t('approval.deny')}
            </button>
            {a.preview && (
              <span className="text-xs text-ink-secondary">{t('approval.runsExactly')}</span>
            )}
          </div>
        )}

        {canApprove && step === 'confirm' && (
          <div className="rounded-lg bg-primary-tint p-3">
            <p className="font-semibold">{t('approval.confirm', { action })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={primary} onClick={() => void send(true)}>
                {t('approval.confirmRun')}
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  setStep('ask');
                }}
              >
                {t('approval.cancel')}
              </button>
            </div>
          </div>
        )}

        {canApprove && step === 'deny' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(false);
            }}
          >
            <label htmlFor={noteId} className="block font-medium">
              {t('approval.denyReason')}
            </label>
            <textarea
              id={noteId}
              dir="auto"
              maxLength={500}
              rows={2}
              className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="submit" className={primary}>
                {t('approval.denySubmit')}
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  setStep('ask');
                }}
              >
                {t('approval.cancel')}
              </button>
            </div>
          </form>
        )}

        {step === 'sending' && <p aria-live="polite">{t('app.loading')}</p>}
      </div>
    </section>
  );
}

/** The change as the approver reviews it: a diff for file edits, a line per other step. */
function Preview({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <pre
      dir="ltr"
      tabIndex={0}
      aria-label={t('approval.preview')}
      className="max-h-96 overflow-auto rounded-lg border border-line bg-raised py-2 text-start font-mono text-[12.5px] leading-5"
    >
      {text.split('\n').map((line, i) => {
        const added = line.startsWith('+') && !line.startsWith('+++');
        const removed = line.startsWith('-') && !line.startsWith('---');
        const hunk = line.startsWith('@@');
        const step = /^\d+\. /.test(line);
        return (
          <span
            key={i}
            className={`block px-3 whitespace-pre ${
              added
                ? 'bg-ok-tint text-ok-text'
                : removed
                  ? 'bg-bad-tint text-bad-text'
                  : hunk
                    ? 'text-ink-secondary'
                    : step
                      ? 'pt-1 font-sans font-semibold text-ink'
                      : ''
            }`}
          >
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}
