import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import en from './locales/en.json';

export type MessageKey = keyof typeof en;

const catalog: Record<MessageKey, string> = en;

interface I18n {
  /** A UI message, with {placeholders} filled in. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Whether a key exists (labels for values that come from the API, like event names). */
  has: (key: string) => key is MessageKey;
  num: (n: number, opts?: Intl.NumberFormatOptions) => string;
  time: (iso: string) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = 'en';
  }, []);

  const value = useMemo<I18n>(() => {
    const timeFormat = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
    return {
      t: (key, vars) =>
        catalog[key].replace(/\{(\w+)\}/g, (match, name: string) =>
          vars && name in vars ? String(vars[name]) : match,
        ),
      has: (key): key is MessageKey => key in catalog,
      num: (n, opts) => new Intl.NumberFormat('en', opts).format(n),
      time: (iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
      },
    };
  }, []);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}
