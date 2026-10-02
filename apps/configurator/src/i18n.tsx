import type { LocalizedText } from '@kodra-agent/schema';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ar from './locales/ar.json';
import en from './locales/en.json';

export type Lang = 'en' | 'ar';
export type MessageKey = keyof typeof en;

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, ar };
const STORAGE_KEY = 'kodra-agent.lang';

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (lang: Lang) => void;
  /** A UI message, with {placeholders} filled in. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Copy that comes from a manifest. */
  lt: (text: LocalizedText) => string;
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
    document.title = `${catalogs[lang]['app.title']} | ${catalogs[lang]['app.productName']}`;
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the language is a convenience only.
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      dir,
      setLang,
      t: (key, vars) =>
        catalogs[lang][key].replace(/\{(\w+)\}/g, (match, name: string) =>
          vars && name in vars ? String(vars[name]) : match,
        ),
      lt: (text) => text[lang],
    }),
    [lang, dir, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}
