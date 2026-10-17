import { useCallback, useEffect, useState } from 'react';
import {
  get,
  pauseAgent,
  resumeAgent,
  session as loadSession,
  SignedOut,
  changePassword,
  signIn,
  signOut,
  type PendingApproval,
  type Session,
  type StatusView,
} from './api.ts';
import { ChatPage } from './chat.tsx';
import { DashboardPage } from './dashboard.tsx';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon, type IconName } from './icons.tsx';
import {
  ActivityPage,
  ApprovalsPage,
  InvestigationsPage,
  OverviewPage,
  UsagePage,
} from './pages.tsx';
import { SettingsPage } from './settings.tsx';
import { StatusContext } from './status.ts';
import { useTheme } from './theme.ts';

const PAGES = [
  { path: '/', label: 'nav.overview', icon: 'overview', Page: OverviewPage },
  { path: '/dashboard', label: 'nav.dashboard', icon: 'gauge', Page: DashboardPage },
  { path: '/chat', label: 'nav.chat', icon: 'chat', Page: ChatPage },
  { path: '/approvals', label: 'nav.approvals', icon: 'shield', Page: ApprovalsPage },
  { path: '/activity', label: 'nav.activity', icon: 'activity', Page: ActivityPage },
  { path: '/investigations', label: 'nav.investigations', icon: 'bell', Page: InvestigationsPage },
  { path: '/usage', label: 'nav.usage', icon: 'chart', Page: UsagePage },
  { path: '/settings', label: 'nav.settings', icon: 'settings', Page: SettingsPage },
] as const satisfies readonly { path: string; label: MessageKey; icon: IconName; Page: unknown }[];

/** How often the shell refreshes the approvals badge and the status card. */
const PENDING_POLL_MS = 10_000;
const STATUS_POLL_MS = 30_000;

function currentPath(): string {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  // Connectors moved into Settings.
  return path === '/connectors' ? '/settings' : path;
}

/** The pages this session can use: Chat only when the agent has it on. */
function pagesFor(session: Session) {
  return PAGES.filter((p) => p.path !== '/chat' || session.features?.chat === true);
}

export function App() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [path, setPath] = useState(currentPath);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const refreshSession = useCallback(() => {
    loadSession()
      .then(setSession)
      .catch(() => {
        setSession({ signedIn: false });
      });
  }, []);

  useEffect(() => {
    refreshSession();
    const onPop = () => {
      setPath(currentPath());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, [refreshSession]);

  // Signed in with the default admin password: only the password screen until it changes.
  const mustChange = session?.signedIn === true && session.mustChangePassword === true;
  const signedIn = session?.signedIn === true && !mustChange;

  // The approvals badge (sidebar and tab title) and the status card.
  const loadStatus = useCallback(() => {
    get<StatusView>('status')
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    const loadPending = () => {
      get<PendingApproval[]>('approvals/pending')
        .then((list) => {
          if (alive) setPending(list.length);
        })
        .catch(() => undefined);
    };
    loadPending();
    loadStatus();
    const a = setInterval(loadPending, PENDING_POLL_MS);
    const b = setInterval(loadStatus, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, [signedIn, path, loadStatus]);

  useEffect(() => {
    const base = `${t('app.title')} | ${t('app.productName')}`;
    document.title = signedIn && pending > 0 ? `(${String(pending)}) ${base}` : base;
  }, [t, signedIn, pending]);

  const go = useCallback((next: string) => {
    window.history.pushState(null, '', next);
    setPath(next);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, []);

  const onSignedOut = useCallback(() => {
    setSession({ signedIn: false });
  }, []);

  if (session === null) {
    return <p className="p-6">{t('app.loading')}</p>;
  }
  if (mustChange) {
    return <ChangePassword onChanged={refreshSession} onSignedOut={onSignedOut} />;
  }
  if (!signedIn) {
    return <SignIn onSignedIn={refreshSession} />;
  }

  const pages = pagesFor(session);
  const page = pages.find((p) => p.path === path) ?? PAGES[0];
  const me = { user: session.user ?? 'console', canApprove: session.canApprove === true };
  const fullBleed = page.path === '/chat';

  return (
    <StatusContext.Provider value={{ status, pending, refresh: loadStatus }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:m-2 focus:rounded focus:bg-raised focus:px-3 focus:py-2"
        >
          {t('app.skip')}
        </a>
        <Sidebar
          pages={pages}
          path={page.path}
          go={go}
          pending={pending}
          status={status}
          me={me}
          menuOpen={menuOpen}
          toggleMenu={() => {
            setMenuOpen((o) => !o);
          }}
          onSignedOut={onSignedOut}
          onChanged={loadStatus}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {status?.paused && (
            <PausedBanner
              paused={status.paused}
              me={me}
              onChanged={loadStatus}
              onSignedOut={onSignedOut}
            />
          )}
          <main
            id="main"
            className={`min-w-0 flex-1 ${fullBleed ? 'flex flex-col' : 'px-4 py-6 md:px-8 md:py-7'}`}
          >
            <page.Page onSignedOut={onSignedOut} me={me} />
          </main>
        </div>
      </div>
    </StatusContext.Provider>
  );
}

/** Shown on every page while changes are paused. */
function PausedBanner({
  paused,
  me,
  onChanged,
  onSignedOut,
}: {
  paused: { by: string; at: string };
  me: { canApprove: boolean };
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const { t, time } = useI18n();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-bad-tint px-4 py-2.5 text-sm text-bad-text md:px-8"
    >
      <span className="flex items-center gap-2">
        <Icon name="pause" size={16} />
        <span>
          <strong>{t('pause.pausedTitle')}</strong>{' '}
          {t('pause.pausedBy', { who: paused.by, time: time(paused.at) })}
        </span>
      </span>
      {me.canApprove ? (
        <button
          type="button"
          className="h-8 rounded-lg bg-raised px-3 font-semibold text-ink shadow-sm hover:bg-muted"
          onClick={() => {
            resumeAgent()
              .then(onChanged)
              .catch((e: unknown) => {
                if (e instanceof SignedOut) onSignedOut();
              });
          }}
        >
          {t('pause.resume')}
        </button>
      ) : (
        <span>{t('pause.askApprover')}</span>
      )}
    </div>
  );
}

function Sidebar({
  pages,
  path,
  go,
  pending,
  status,
  me,
  menuOpen,
  toggleMenu,
  onSignedOut,
  onChanged,
}: {
  pages: ReturnType<typeof pagesFor>;
  path: string;
  go: (path: string) => void;
  pending: number;
  status: StatusView | null;
  me: { user: string; canApprove: boolean };
  menuOpen: boolean;
  toggleMenu: () => void;
  onSignedOut: () => void;
  onChanged: () => void;
}) {
  const { t, lang, setLang } = useI18n();
  const { dark, toggle } = useTheme();
  const ready = status?.connectors.filter((c) => c.available).length ?? 0;

  return (
    <aside className="flex shrink-0 flex-col gap-5 border-b border-line bg-raised px-3 py-4 md:sticky md:top-0 md:h-screen md:w-60 md:border-e md:border-b-0 md:py-5">
      <div className="flex items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-[15px] font-bold text-white"
          >
            K
          </span>
          <span className="text-[15px] font-semibold">{t('app.productName')}</span>
        </div>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-medium md:hidden"
          aria-expanded={menuOpen}
          aria-controls="console-nav"
          onClick={toggleMenu}
        >
          {t('nav.menu')}
          <Icon name="chevronDown" size={16} />
        </button>
      </div>

      <nav
        id="console-nav"
        aria-label={t('nav.label')}
        className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-5 md:flex md:flex-1`}
      >
        <ul className="flex flex-col gap-0.5">
          {pages.map((p) => {
            const active = p.path === path;
            return (
              <li key={p.path}>
                <a
                  href={p.path}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${
                    active
                      ? 'bg-nav-active font-semibold text-nav-active-text'
                      : 'font-medium text-ink-secondary hover:bg-muted hover:text-ink'
                  }`}
                  onClick={(e) => {
                    e.preventDefault();
                    go(p.path);
                  }}
                >
                  <Icon name={p.icon} />
                  <span className="flex-1">{t(p.label)}</span>
                  {p.path === '/approvals' && pending > 0 && (
                    <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] leading-[18px] font-semibold text-white">
                      {pending}
                      <span className="sr-only"> {t('nav.waiting')}</span>
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
          {status && (
            <>
              <div className="flex items-center gap-2 text-[13px]">
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${status.paused ? 'bg-bad-text' : 'bg-ok'}`}
                />
                <span>
                  {t(status.paused ? 'app.paused' : 'app.running', { version: status.version })}
                </span>
              </div>
              <div className="text-xs leading-[18px] text-ink-secondary">
                <bdi dir="ltr">{status.model.split('/').at(-1)}</bdi>
                <br />
                {t('app.connectorsReady', { ready, total: status.connectors.length })}
              </div>
              {!status.paused && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-raised text-[13px] font-medium hover:bg-muted"
                  onClick={() => {
                    pauseAgent()
                      .then(onChanged)
                      .catch((e: unknown) => {
                        if (e instanceof SignedOut) onSignedOut();
                      });
                  }}
                >
                  <Icon name="pause" size={14} />
                  {t('pause.pause')}
                </button>
              )}
            </>
          )}
          <div className="flex flex-col gap-2.5 border-t border-line pt-2.5">
            <span className="flex min-w-0 flex-col">
              <bdi dir="ltr" className="truncate text-[13px] font-semibold">
                {me.user}
              </bdi>
              <span className="text-xs text-ink-secondary">
                {t(me.canApprove ? 'app.roleApprover' : 'app.roleViewer')}
              </span>
            </span>
            <span className="flex gap-1.5">
              <button
                type="button"
                aria-label={t(dark ? 'app.lightTheme' : 'app.darkTheme')}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line-strong text-ink-secondary hover:text-ink"
                onClick={toggle}
              >
                <Icon name={dark ? 'sun' : 'moon'} size={16} />
              </button>
              <button
                type="button"
                lang={lang === 'en' ? 'ar' : 'en'}
                aria-label={t('app.switchLanguageLabel')}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line-strong text-ink-secondary hover:text-ink"
                onClick={() => {
                  setLang(lang === 'en' ? 'ar' : 'en');
                }}
              >
                <Icon name="languages" size={16} />
              </button>
              <button
                type="button"
                aria-label={t('app.signOut')}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line-strong text-ink-secondary hover:text-ink"
                onClick={() => {
                  void signOut().then(onSignedOut);
                }}
              >
                <Icon name="logout" size={16} />
              </button>
            </span>
          </div>
        </div>
      </nav>
    </aside>
  );
}

const FIELD = 'mt-1.5 h-10 w-full rounded-lg border border-line-strong bg-surface px-3';
const SUBMIT =
  'mt-5 h-10 w-full rounded-lg bg-primary font-semibold text-white shadow-md hover:bg-primary-deep disabled:opacity-50';

function Brand() {
  const { t } = useI18n();
  return (
    <div className="mb-5 flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="inline-flex size-9 items-center justify-center rounded-lg bg-primary font-bold text-white"
      >
        K
      </span>
      <span className="font-semibold">{t('app.productName')}</span>
    </div>
  );
}

function LanguageSwitch() {
  const { t, lang, setLang } = useI18n();
  return (
    <button
      type="button"
      className="text-sm text-ink-secondary underline underline-offset-2"
      lang={lang === 'en' ? 'ar' : 'en'}
      aria-label={t('app.switchLanguageLabel')}
      onClick={() => {
        setLang(lang === 'en' ? 'ar' : 'en');
      }}
    >
      {t('app.switchLanguage')}
    </button>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  type?: 'text' | 'password';
  autoComplete: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label className="mt-4 block text-sm font-medium" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'password'}
        autoComplete={props.autoComplete}
        dir="ltr"
        className={FIELD}
        value={props.value}
        aria-invalid={props.invalid}
        aria-describedby={props.invalid ? 'login-problem' : undefined}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      />
    </>
  );
}

function Problem({ problem }: { problem: MessageKey | null }) {
  const { t } = useI18n();
  if (!problem) return null;
  return (
    <p id="login-problem" role="alert" className="mt-2 text-sm font-semibold text-bad-text">
      {t(problem)}
    </p>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  // The admin signs in with a password; a sign-in token still works for everyone else.
  const [withToken, setWithToken] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = withToken ? token.trim() !== '' : username.trim() !== '' && password !== '';
  const submit = async () => {
    setBusy(true);
    const result = await signIn(
      withToken ? { token: token.trim() } : { username: username.trim(), password },
    ).catch(() => 'wrong' as const);
    setBusy(false);
    if (result === 'ok') {
      setToken('');
      setPassword('');
      onSignedIn();
    } else if (result === 'too-many') setProblem('login.tooMany');
    else setProblem(withToken ? 'login.wrong' : 'login.wrongPassword');
  };
  const typed = (set: (v: string) => void) => (v: string) => {
    set(v);
    setProblem(null);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Brand />
        <h1 className="text-2xl font-bold">{t('login.title')}</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          {t(withToken ? 'login.intro' : 'login.passwordIntro')}
        </p>
        {withToken ? (
          <Field
            id="token"
            label={t('login.token')}
            value={token}
            autoComplete="current-password"
            invalid={problem !== null}
            onChange={typed(setToken)}
          />
        ) : (
          <>
            <Field
              id="username"
              type="text"
              label={t('login.username')}
              value={username}
              autoComplete="username"
              invalid={problem !== null}
              onChange={typed(setUsername)}
            />
            <Field
              id="password"
              label={t('login.password')}
              value={password}
              autoComplete="current-password"
              invalid={problem !== null}
              onChange={typed(setPassword)}
            />
          </>
        )}
        <Problem problem={problem} />
        <button type="submit" disabled={busy || !ready} className={SUBMIT}>
          {t('login.submit')}
        </button>
        <button
          type="button"
          className="mt-3 w-full text-sm text-primary-text underline underline-offset-2"
          onClick={() => {
            setWithToken(!withToken);
            setProblem(null);
          }}
        >
          {t(withToken ? 'login.usePassword' : 'login.useToken')}
        </button>
      </form>
      <LanguageSwitch />
    </main>
  );
}

/** After signing in with admin/admin: a new password before anything else. */
function ChangePassword({
  onChanged,
  onSignedOut,
}: {
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (next !== repeat) {
      setProblem('password.mismatch');
      return;
    }
    setBusy(true);
    const result = await changePassword(current, next).catch(() => 'failed' as const);
    setBusy(false);
    if (result === 'ok') onChanged();
    else setProblem(`password.${result}`);
  };
  const typed = (set: (v: string) => void) => (v: string) => {
    set(v);
    setProblem(null);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Brand />
        <h1 className="text-2xl font-bold">{t('password.title')}</h1>
        <p className="mt-2 text-sm text-ink-secondary">{t('password.intro')}</p>
        <Field
          id="current-password"
          label={t('password.current')}
          value={current}
          autoComplete="current-password"
          invalid={problem !== null}
          onChange={typed(setCurrent)}
        />
        <Field
          id="new-password"
          label={t('password.new')}
          value={next}
          autoComplete="new-password"
          invalid={problem !== null}
          onChange={typed(setNext)}
        />
        <Field
          id="repeat-password"
          label={t('password.repeat')}
          value={repeat}
          autoComplete="new-password"
          invalid={problem !== null}
          onChange={typed(setRepeat)}
        />
        <p className="mt-2 text-sm text-ink-secondary">{t('password.rules')}</p>
        <Problem problem={problem} />
        <button
          type="submit"
          disabled={busy || current === '' || next === '' || repeat === ''}
          className={SUBMIT}
        >
          {t('password.submit')}
        </button>
        <button
          type="button"
          className="mt-3 w-full text-sm text-ink-secondary underline underline-offset-2"
          onClick={() => {
            void signOut().then(onSignedOut);
          }}
        >
          {t('app.signOut')}
        </button>
      </form>
      <LanguageSwitch />
    </main>
  );
}
