import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'kodra-agent.console.theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Storage can be blocked; follow the system setting.
  }
  return 'system';
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Applies a theme to <html> (the CSS reads data-theme). */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark());
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** Light, dark, or the system setting; remembered in this browser only. */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const [dark, setDark] = useState(
    () => choice === 'dark' || (choice === 'system' && systemDark()),
  );

  useEffect(() => {
    applyTheme(choice);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (choice === 'system') {
        applyTheme('system');
        setDark(media.matches);
      }
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [choice]);

  const toggle = useCallback(() => {
    const next: ThemeChoice = dark ? 'light' : 'dark';
    setChoice(next);
    setDark(!dark);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A convenience only.
    }
  }, [dark]);

  return { dark, toggle };
}
