import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ar from './locales/ar.json';
import en from './locales/en.json';

export type Lang = 'en' | 'ar';
export type MessageKey = keyof typeof en;

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, ar };
const STORAGE_KEY = 'kodra-agent.console.lang';

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (lang: Lang) => void;
  /** A UI message, with {placeholders} filled in. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Whether a key exists (labels for values that come from the API, like event names). */
  has: (key: string) => key is MessageKey;
  /** Numbers in Latin digits in both languages: they are technical values. */
  num: (n: number, opts?: Intl.NumberFormatOptions) => string;
  time: (iso: string) => string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    // Storage can be blocked; fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the language is a convenience only.
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const locale = lang === 'ar' ? 'ar-u-nu-latn' : 'en';
    const timeFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
    return {
      lang,
      dir,
      setLang,
      t: (key, vars) =>
        catalogs[lang][key].replace(/\{(\w+)\}/g, (match, name: string) =>
          vars && name in vars ? String(vars[name]) : match,
        ),
      has: (key): key is MessageKey => key in catalogs.en,
      num: (n, opts) => new Intl.NumberFormat(locale, opts).format(n),
      time: (iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
      },
    };
  }, [lang, dir, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}
