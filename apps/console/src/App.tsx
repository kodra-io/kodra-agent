import { useCallback, useEffect, useState } from 'react';
import { signedIn, signIn, signOut } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import {
  ActivityPage,
  ApprovalsPage,
  ConnectorsPage,
  InvestigationsPage,
  OverviewPage,
  UsagePage,
} from './pages.tsx';

const PAGES = [
  { path: '/', label: 'nav.overview', Page: OverviewPage },
  { path: '/connectors', label: 'nav.connectors', Page: ConnectorsPage },
  { path: '/activity', label: 'nav.activity', Page: ActivityPage },
  { path: '/investigations', label: 'nav.investigations', Page: InvestigationsPage },
  { path: '/usage', label: 'nav.usage', Page: UsagePage },
  { path: '/approvals', label: 'nav.approvals', Page: ApprovalsPage },
] as const satisfies readonly { path: string; label: MessageKey; Page: unknown }[];

function currentPath(): string {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return PAGES.some((p) => p.path === path) ? path : '/';
}

export function App() {
  const { t, lang, setLang } = useI18n();
  const [session, setSession] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    signedIn()
      .then((ok) => {
        setSession(ok ? 'in' : 'out');
      })
      .catch(() => {
        setSession('out');
      });
    const onPop = () => {
      setPath(currentPath());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const go = useCallback((next: string) => {
    window.history.pushState(null, '', next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);

  const onSignedOut = useCallback(() => {
    setSession('out');
  }, []);

  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="font-heading text-lg font-bold">
            {t('app.productName')} <span className="text-ink-secondary">· {t('app.title')}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-primary-tint"
              lang={lang === 'en' ? 'ar' : 'en'}
              aria-label={t('app.switchLanguageLabel')}
              onClick={() => {
                setLang(lang === 'en' ? 'ar' : 'en');
              }}
            >
              {t('app.switchLanguage')}
            </button>
            {session === 'in' && (
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-primary-tint"
                onClick={() => {
                  void signOut().then(onSignedOut);
                }}
              >
                {t('app.signOut')}
              </button>
            )}
          </div>
        </div>
        {session === 'in' && (
          <nav aria-label={t('nav.label')} className="mx-auto max-w-6xl overflow-x-auto px-4">
            <ul className="flex gap-1">
              {PAGES.map((p) => (
                <li key={p.path}>
                  <a
                    href={p.path}
                    aria-current={p.path === path ? 'page' : undefined}
                    className={`block whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                      p.path === path
                        ? 'border-primary font-semibold text-primary'
                        : 'border-transparent text-ink-secondary hover:text-ink'
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(p.path);
                    }}
                  >
                    {t(p.label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        {session === 'unknown' && <p>{t('app.loading')}</p>}
        {session === 'out' && (
          <SignIn
            onSignedIn={() => {
              setSession('in');
            }}
          />
        )}
        {session === 'in' && <page.Page onSignedOut={onSignedOut} />}
      </main>

      {session === 'in' && (
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-sm text-ink-secondary">
          {t('app.readOnly')}
        </footer>
      )}
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const result = await signIn(token.trim()).catch(() => 'wrong' as const);
    setBusy(false);
    if (result === 'ok') {
      setToken('');
      onSignedIn();
    } else {
      setProblem(result === 'too-many' ? 'login.tooMany' : 'login.wrong');
    }
  };

  return (
    <form
      className="mx-auto mt-8 max-w-md rounded-lg border border-line bg-white p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-2xl font-bold">{t('login.title')}</h1>
      <p className="mt-2 text-sm text-ink-secondary">{t('login.intro')}</p>
      <label className="mt-4 block text-sm font-semibold" htmlFor="token">
        {t('login.token')}
      </label>
      <input
        id="token"
        type="password"
        autoComplete="current-password"
        dir="ltr"
        className="mt-1 w-full rounded-md border border-line px-3 py-2"
        value={token}
        aria-invalid={problem !== null}
        aria-describedby={problem ? 'login-problem' : undefined}
        onChange={(e) => {
          setToken(e.target.value);
          setProblem(null);
        }}
      />
      {problem && (
        <p id="login-problem" role="alert" className="mt-2 text-sm font-semibold">
          {t(problem)}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || token.trim() === ''}
        className="mt-4 rounded-md bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-deep disabled:opacity-50"
      >
        {t('login.submit')}
      </button>
    </form>
  );
}
