import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import en from './locales/en.json';

export type MessageKey = keyof typeof en;

const catalog: Record<MessageKey, string> = en;

interface I18n {
  /** A UI message, with {placeholders} filled in. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = 'en';
    document.title = `${catalog['app.title']} | ${catalog['app.productName']}`;
  }, []);

  const value = useMemo<I18n>(
    () => ({
      t: (key, vars) =>
        catalog[key].replace(/\{(\w+)\}/g, (match, name: string) =>
          vars && name in vars ? String(vars[name]) : match,
        ),
    }),
    [],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}
