import { useId, useState } from 'react';
import { ApiError, decide, SignedOut, type PendingApproval } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Badge, Ltr } from './ui.tsx';

type Step = 'ask' | 'confirm' | 'deny' | 'sending' | 'closed';

/**
 * A change waiting for a decision. Approving takes a second, explicit confirmation; denying
 * can say why. Only a console approver sees the buttons; the agent checks again anyway.
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
    <div
      className="rounded-lg border-2 border-primary bg-white p-4"
      role="group"
      aria-label={t('approval.needed')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold">
          {t('approval.needed')}: {a.title ? <bdi dir="auto">{a.title}</bdi> : <Ltr>{action}</Ltr>}
        </p>
        <Badge tone="plain">{has(risk) ? t(risk) : a.risk}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-secondary">{t('approval.why')}</dt>
        <dd className="whitespace-pre-wrap" dir="auto">
          {a.reason}
        </dd>
        <dt className="text-ink-secondary">{t(a.preview ? 'approval.steps' : 'approval.args')}</dt>
        <dd className="break-all font-mono text-xs">
          <bdi dir="ltr">{a.args}</bdi>
        </dd>
        {a.requestedBy && (
          <>
            <dt className="text-ink-secondary">{t('approvals.by')}</dt>
            <dd>
              <Ltr>{a.requestedBy}</Ltr>
            </dd>
          </>
        )}
      </dl>
      {a.preview && <Preview text={a.preview} />}
      <p className="mt-2 text-sm text-ink-secondary">
        {t('approval.expires', { time: time(a.expiresAt) })}
      </p>

      {problem && (
        <p role="alert" className="mt-2 text-sm font-semibold">
          {problem}
        </p>
      )}

      {!canApprove && <p className="mt-3 text-sm">{t('approval.cannot')}</p>}

      {canApprove && step === 'ask' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-deep"
            onClick={() => {
              setStep('confirm');
            }}
          >
            {t('approval.approve')}
          </button>
          <button
            type="button"
            className="rounded-md border border-line px-4 py-2 text-sm font-semibold hover:bg-primary-tint"
            onClick={() => {
              setStep('deny');
            }}
          >
            {t('approval.deny')}
          </button>
        </div>
      )}

      {canApprove && step === 'confirm' && (
        <div className="mt-3 rounded-md bg-primary-tint p-3">
          <p className="text-sm font-semibold">{t('approval.confirm', { action })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-deep"
              onClick={() => void send(true)}
            >
              {t('approval.confirmRun')}
            </button>
            <button
              type="button"
              className="rounded-md border border-line bg-white px-4 py-2 text-sm hover:bg-primary-tint"
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
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
        >
          <label htmlFor={noteId} className="block text-sm font-semibold">
            {t('approval.denyReason')}
          </label>
          <textarea
            id={noteId}
            dir="auto"
            maxLength={500}
            rows={2}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-deep"
            >
              {t('approval.denySubmit')}
            </button>
            <button
              type="button"
              className="rounded-md border border-line bg-white px-4 py-2 text-sm hover:bg-primary-tint"
              onClick={() => {
                setStep('ask');
              }}
            >
              {t('approval.cancel')}
            </button>
          </div>
        </form>
      )}

      {step === 'sending' && (
        <p className="mt-3 text-sm" aria-live="polite">
          {t('app.loading')}
        </p>
      )}
    </div>
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
      className="mt-3 max-h-96 overflow-auto rounded-md border border-line bg-white p-3 text-start font-mono text-xs leading-5"
    >
      {text.split('\n').map((line, i) => (
        <span
          key={i}
          className={`block whitespace-pre ${
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-primary-tint text-ink'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'text-ink-secondary'
                : ''
          }`}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}
