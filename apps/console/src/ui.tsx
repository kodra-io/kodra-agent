import type { ReactNode } from 'react';
import type { ContextWarning } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';

export function Page({
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
          <h1 id="page-title" className="text-3xl font-bold">
            {t(title)}
          </h1>
          {intro && <p className="mt-1 text-sm text-ink-secondary">{t(intro)}</p>}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="h-9 rounded-lg border border-line-strong bg-raised px-3 text-sm font-medium hover:bg-muted"
        >
          {t('app.refresh')}
        </button>
      </div>
      <div className="mt-6" aria-busy={loading}>
        {error && (
          <p role="alert" className="rounded-md border border-line bg-raised p-3">
            {t('app.error', { message: error })}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

const TONES = {
  accent: 'bg-primary-tint text-primary-text',
  ok: 'bg-ok-tint text-ok-text',
  bad: 'bg-bad-tint text-bad-text',
  warn: 'bg-warn-tint text-warn-text',
  plain: 'border border-line bg-raised text-ink',
};

/** A small label. State tones always carry a word, never color alone. */
export function Badge({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-raised">
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

export const Cell = ({ children, mono }: { children: ReactNode; mono?: boolean }) => (
  <td className={`px-3 py-2 align-top ${mono ? 'font-mono text-xs break-all' : ''}`}>{children}</td>
);

/** A model's context window is too small for the agent's prompt, and how to fix it. */
export function ContextNote({ warning }: { warning: ContextWarning }) {
  const { t, num } = useI18n();
  return (
    <p role="alert" className="rounded-lg border border-line bg-bad-tint p-3 text-sm text-bad-text">
      {t('context.warning', {
        model: warning.model,
        window: num(warning.window),
        needed: num(warning.needed),
      })}
    </p>
  );
}

/** Technical values: names, ids, arguments. */
export const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-xs">{children}</span>
);
