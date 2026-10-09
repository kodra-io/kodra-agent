import type { ReactNode } from 'react';
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

export function Badge({ tone, children }: { tone: 'accent' | 'plain'; children: ReactNode }) {
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

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
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

export const Cell = ({ children, mono }: { children: ReactNode; mono?: boolean }) => (
  <td className={`px-3 py-2 align-top ${mono ? 'font-mono text-xs break-all' : ''}`}>{children}</td>
);

/** Technical values (names, ids, arguments) read left to right in both languages. */
export const Ltr = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="font-mono text-xs">
    {children}
  </bdi>
);
