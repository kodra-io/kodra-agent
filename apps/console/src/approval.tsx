import { useId, useState } from 'react';
import { ApiError, decide, SignedOut, type PendingApproval } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Mono } from './ui.tsx';

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
  approval: Omit<
    PendingApproval,
    | 'requestedBy'
    | 'environment'
    | 'needed'
    | 'approvedBy'
    | 'cannotApprove'
    | 'needs'
    | 'changeRefPattern'
    | 'changeRef'
    | 'override'
    | 'freeze'
  > &
    Partial<PendingApproval>;
  canApprove: boolean;
  onDecided: () => void;
  onSignedOut: () => void;
}) {
  const { t, has, time } = useI18n();
  const [step, setStep] = useState<Step>('ask');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [counted, setCounted] = useState(false);
  const [changeRef, setChangeRef] = useState('');
  const [reason, setReason] = useState('');
  const needs = a.needs ?? { changeRef: false, reason: false };
  const refId = useId();
  const reasonId = useId();
  const needed = a.needed ?? 1;
  const approvedBy = a.approvedBy ?? [];
  // A console approver may still be unable to approve this one: they asked for it, or
  // already approved it. The agent checks again anyway.
  const refusalText = (code: string) => {
    const key = code === 'not-console-approver' ? 'approval.cannot' : `approval.refused.${code}`;
    return has(key) ? t(key) : code;
  };
  const blocked =
    a.cannotApprove && a.cannotApprove !== 'not-console-approver' ? a.cannotApprove : null;
  const allowed = canApprove && !blocked && !counted;
  const noteId = useId();
  const titleId = useId();
  // A proposed change is named by its title; a single tool call by connector/tool.
  const action = a.title ?? `${a.connector}/${a.tool}`;
  const risk = `risk.${a.risk}`;

  const send = async (approve: boolean) => {
    setStep('sending');
    setProblem(null);
    try {
      const { result } = await decide(
        a.id,
        approve,
        approve
          ? {
              ...(needs.changeRef ? { changeRef: changeRef.trim() } : {}),
              ...(needs.reason ? { reason: reason.trim() } : {}),
            }
          : { note: note.trim() },
      );
      if (result === 'counted') {
        setCounted(true);
        setStep('closed');
      }
      onDecided();
    } catch (e) {
      if (e instanceof SignedOut) {
        onSignedOut();
        return;
      }
      if (e instanceof ApiError && e.status === 403 && e.refusal) {
        setProblem(refusalText(e.refusal));
        // A missing or malformed reference or reason is fixed in place.
        const fixable = ['change-ref-missing', 'change-ref-format', 'reason-missing'];
        setStep(fixable.includes(e.refusal) ? 'confirm' : 'closed');
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
              {a.title ? <span>{a.title}</span> : <Mono>{action}</Mono>}
            </span>
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
          {a.environment && (
            <span className="rounded-full border border-line-strong bg-raised px-2 py-0.5 font-semibold text-ink">
              {t('approval.environment', { name: a.environment })}
            </span>
          )}
          <span>
            {has(risk) ? t(risk) : a.risk} · {t('approval.expires', { time: time(a.expiresAt) })}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5 text-sm">
        <p className="text-ink-secondary">
          <span className="font-medium text-ink">{t('approval.why')}:</span>{' '}
          <span className="whitespace-pre-wrap">{a.reason}</span>
        </p>
        {a.requestedBy && (
          <p className="text-xs text-ink-secondary">
            {t('approvals.by')}: <Mono>{a.requestedBy}</Mono>
          </p>
        )}
        {a.freeze && (
          <p className="rounded-lg border border-line-strong bg-bad-tint p-2.5 text-sm font-medium text-bad-text">
            {t('approval.frozen', {
              environment: a.environment ?? '',
              name: a.freeze.name,
              until: a.freeze.until,
              timezone: a.freeze.timezone,
            })}
          </p>
        )}
        {(a.changeRef || a.override) && (
          <p className="text-xs text-ink-secondary">
            {a.changeRef && (
              <>
                {t('approval.changeRefGiven')}: <Mono>{a.changeRef}</Mono>
              </>
            )}
            {a.changeRef && a.override && ' · '}
            {a.override && (
              <>
                {t('approval.overrideGiven')}: <span>{a.override}</span>
              </>
            )}
          </p>
        )}
        {needed > 1 && (
          <p className="text-xs font-semibold">
            {t('approval.progress', { done: approvedBy.length, needed })}
            {approvedBy.length > 0 && (
              <span className="font-normal text-ink-secondary">
                {' · '}
                {t('approval.approvedBy')}: <Mono>{approvedBy.join(', ')}</Mono>
              </span>
            )}
          </p>
        )}
        {a.preview ? (
          <>
            <p className="text-xs text-ink-secondary">
              <span className="font-medium">{t('approval.steps')}:</span>{' '}
              <span className="font-mono">{a.args}</span>
            </p>
            <DiffView text={a.preview} label={t('approval.preview')} />
          </>
        ) : (
          <div>
            <p className="text-xs font-medium text-ink-secondary">{t('approval.args')}</p>
            <pre className="mt-1 overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
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
        {canApprove && blocked && !problem && (
          <p className="text-ink-secondary">{refusalText(blocked)}</p>
        )}
        {counted && (
          <p role="status" className="font-semibold text-ok-text">
            {t('approval.counted')}
          </p>
        )}

        {allowed && step === 'ask' && (
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

        {allowed && step === 'confirm' && (
          <div className="rounded-lg bg-primary-tint p-3">
            <p className="font-semibold">{t('approval.confirm', { action })}</p>
            {needs.reason && (
              <div className="mt-2">
                <label htmlFor={reasonId} className="block font-medium">
                  {t('approval.reasonLabel')}
                </label>
                <textarea
                  id={reasonId}
                  required
                  maxLength={500}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              </div>
            )}
            {needs.changeRef && (
              <div className="mt-2">
                <label htmlFor={refId} className="block font-medium">
                  {t('approval.changeRefLabel')}
                </label>
                <input
                  id={refId}
                  required
                  maxLength={100}
                  aria-describedby={a.changeRefPattern ? `${refId}-hint` : undefined}
                  className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono"
                  value={changeRef}
                  onChange={(e) => {
                    setChangeRef(e.target.value);
                  }}
                />
                {a.changeRefPattern && (
                  <p id={`${refId}-hint`} className="mt-1 text-xs text-ink-secondary">
                    {t('approval.changeRefFormat')}: <Mono>{a.changeRefPattern}</Mono>
                  </p>
                )}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={
                  (needs.reason && !reason.trim()) || (needs.changeRef && !changeRef.trim())
                }
                onClick={() => void send(true)}
              >
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

        {allowed && step === 'deny' && (
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

/** A change to review: a diff for file edits, a line per other step. */
export function DiffView({ text, label }: { text: string; label: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
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
