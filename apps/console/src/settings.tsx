import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  get,
  post,
  SignedOut,
  type AccessChange,
  type CheckRow,
  type ConfigField,
  type ConnectorSettings,
  type ConnectorView,
  type Localized,
  type SettingsPatch,
  type SettingsPreview,
  type SettingsView,
  type StatusView,
} from './api.ts';
import { DiffView } from './approval.tsx';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { useLoad } from './load.ts';
import { ConnectorTools, type PageProps } from './pages.tsx';
import { PeoplePanel } from './people.tsx';
import { useStatus } from './status.ts';
import { Badge, Ltr } from './ui.tsx';

type Tab = 'connectors' | 'policy' | 'limits' | 'console' | 'people';
const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'connectors', label: 'settings.tab.connectors' },
  { id: 'policy', label: 'settings.tab.policy' },
  { id: 'limits', label: 'settings.tab.limits' },
  { id: 'console', label: 'settings.tab.console' },
  { id: 'people', label: 'settings.tab.people' },
];

const PREVIEW_DELAY_MS = 400;
const RESTART_TIMEOUT_MS = 90_000;

const input =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 disabled:opacity-60';
const primary =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-white shadow-md hover:bg-primary-deep disabled:opacity-50';
const secondary =
  'inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-raised px-4 font-medium hover:bg-muted disabled:opacity-50';

function isEmpty(patch: SettingsPatch): boolean {
  return Object.values(patch).every(
    (v) => v === undefined || (typeof v === 'object' && Object.keys(v as object).length === 0),
  );
}

/** Waits for the agent to come back after a restart: it reports a new start time. */
async function waitForRestart(oldStart: string | undefined): Promise<boolean> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    try {
      const status = await get<StatusView>('status');
      if (status.startedAt !== oldStart) return true;
    } catch {
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function SettingsPage({ onSignedOut, me }: PageProps) {
  const { t, time } = useI18n();
  const load = useCallback(() => get<SettingsView>('settings'), []);
  const { data: view, error, reload } = useLoad(load, onSignedOut);
  const loadLive = useCallback(() => get<ConnectorView[]>('connectors'), []);
  const live = useLoad(loadLive, onSignedOut);
  const [tab, setTab] = useState<Tab>('connectors');
  const [open, setOpen] = useState<string | null>(null);
  const [patch, setPatch] = useState<SettingsPatch>({});
  const [latestPreview, setPreview] = useState<SettingsPreview | null>(null);
  const [phase, setPhase] = useState<'edit' | 'confirm' | 'saving' | 'restarting'>('edit');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const canEdit = me.canApprove && view?.editable === true;
  // A preview only means something while there are edits.
  const preview = isEmpty(patch) ? null : latestPreview;
  const { status, refresh } = useStatus();

  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof SignedOut) onSignedOut();
      else setProblem(e instanceof Error ? e.message : String(e));
    },
    [onSignedOut],
  );

  // The diff, refreshed shortly after each edit.
  useEffect(() => {
    if (!canEdit || isEmpty(patch)) return;
    const timer = setTimeout(() => {
      post<SettingsPreview>('settings/preview', { patch }).then(setPreview).catch(failed);
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [patch, canEdit, failed]);

  const restartThen = async (action: Promise<unknown>) => {
    if (!view) return;
    setProblem(null);
    setPhase('saving');
    try {
      await action;
    } catch (e) {
      setPhase('edit');
      if (e instanceof ApiError && e.status === 409) setProblem(t('settings.stale'));
      else failed(e);
      return;
    }
    setPhase('restarting');
    const back = await waitForRestart(status?.startedAt);
    refresh();
    setPatch({});
    setPreview(null);
    setPhase('edit');
    setConfirmUndo(false);
    if (!back) setProblem(t('settings.notBack'));
    reload();
    live.reload();
  };

  const setConnector = (
    id: string,
    change: { enabled?: boolean; access?: string; config?: Record<string, unknown> },
  ) => {
    setPatch((p) => {
      const current = p.connectors?.[id] ?? {};
      return {
        ...p,
        connectors: {
          ...p.connectors,
          [id]: {
            ...current,
            ...change,
            ...(change.config ? { config: { ...current.config, ...change.config } } : {}),
          },
        },
      };
    });
  };
  const setSection = <K extends 'policy' | 'model' | 'limits' | 'console'>(
    section: K,
    change: NonNullable<SettingsPatch[K]>,
  ) => {
    setPatch((p) => ({ ...p, [section]: { ...p[section], ...change } }));
  };

  if (phase === 'restarting') {
    return (
      <div
        role="status"
        className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center"
      >
        <Icon name="spinner" size={28} className="animate-spin text-primary-text" />
        <h1 className="text-xl font-semibold">{t('settings.restarting')}</h1>
        <p className="text-ink-secondary">{t('settings.restartingText')}</p>
      </div>
    );
  }

  const opened = view?.connectors.find((c) => c.id === open);

  return (
    <section aria-labelledby="page-title" className="flex flex-col gap-5">
      <header>
        <h1 id="page-title" className="text-3xl font-bold">
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-ink-secondary">{t('settings.intro')}</p>
      </header>

      {error && (
        <p role="alert" className="rounded-lg border border-line bg-bad-tint p-3 text-bad-text">
          {t('app.error', { message: error })}
        </p>
      )}
      {view && !view.editable && (
        <p className="rounded-xl border border-line bg-raised p-4">{t('settings.kubernetes')}</p>
      )}
      {view?.editable && !me.canApprove && (
        <p className="rounded-xl border border-line bg-raised p-4">{t('settings.viewOnly')}</p>
      )}

      {view?.lastChange && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <span className="flex items-center gap-2.5 text-ink-secondary">
            <Icon name="history" size={18} />
            {t('settings.lastChange', {
              detail: view.lastChange.detail,
              who: view.lastChange.by,
              time: time(view.lastChange.at),
            })}
          </span>
          {canEdit && view.undoable && !confirmUndo && (
            <button
              type="button"
              className={secondary}
              onClick={() => {
                setConfirmUndo(true);
              }}
            >
              {t('settings.undo')}
            </button>
          )}
          {confirmUndo && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('settings.undoConfirm')}</span>
              <button
                type="button"
                className={primary}
                onClick={() => void restartThen(post('settings/undo', {}))}
              >
                {t('settings.undoYes')}
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  setConfirmUndo(false);
                }}
              >
                {t('approval.cancel')}
              </button>
            </span>
          )}
        </div>
      )}

      <div
        role="tablist"
        aria-label={t('settings.title')}
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {TABS.filter((tb) => tb.id !== 'people' || me.canApprove).map((tb) => (
          <button
            key={tb.id}
            type="button"
            role="tab"
            id={`settings-tab-${tb.id}`}
            aria-selected={tab === tb.id}
            aria-controls="settings-panel"
            className={`h-10 border-b-2 px-3.5 text-sm ${
              tab === tb.id
                ? 'border-primary font-semibold text-primary-text'
                : 'border-transparent font-medium text-ink-secondary hover:text-ink'
            }`}
            onClick={() => {
              setTab(tb.id);
              setOpen(null);
            }}
          >
            {t(tb.label)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          className="min-w-0 flex-[999_1_460px]"
        >
          {view && tab === 'connectors' && !opened && (
            <ConnectorList view={view} live={live.data ?? []} patch={patch} onOpen={setOpen} />
          )}
          {view && tab === 'connectors' && opened && (
            <ConnectorEditor
              connector={opened}
              live={live.data?.find((c) => c.id === opened.id)}
              patch={patch.connectors?.[opened.id] ?? {}}
              canEdit={canEdit}
              onChange={(change) => {
                setConnector(opened.id, change);
              }}
              onBack={() => {
                setOpen(null);
              }}
              onSecretSaved={(action) => void restartThen(action)}
              onSignedOut={onSignedOut}
            />
          )}
          {view && tab === 'policy' && (
            <PolicyEditor
              view={view}
              patch={patch}
              canEdit={canEdit}
              onChange={(c) => {
                setSection('policy', c);
              }}
            />
          )}
          {view && tab === 'limits' && (
            <LimitsEditor
              view={view}
              patch={patch}
              canEdit={canEdit}
              onModel={(c) => {
                setSection('model', c);
              }}
              onLimits={(c) => {
                setSection('limits', c);
              }}
            />
          )}
          {tab === 'people' && me.canApprove && (
            <PeoplePanel
              me={me.user}
              onSignedOut={onSignedOut}
              onRestarted={() => {
                refresh();
                reload();
                live.reload();
              }}
            />
          )}
          {view && tab === 'console' && (
            <Card title={t('settings.console.title')}>
              <Toggle
                label={t('settings.console.chat')}
                hint={t('settings.console.chatHint')}
                checked={patch.console?.chat ?? view.console.chat}
                disabled={!canEdit}
                onChange={(chat) => {
                  setSection('console', { chat });
                }}
              />
              <p className="text-sm text-ink-secondary">{t('settings.console.offHint')}</p>
            </Card>
          )}
        </div>

        {canEdit && !isEmpty(patch) && (
          <aside
            aria-labelledby="review-title"
            className="flex min-w-0 flex-[1_1_340px] flex-col gap-3.5 rounded-xl border border-primary bg-raised p-5 shadow-md"
          >
            <div>
              <h2 id="review-title" className="text-lg font-semibold">
                {t('settings.review')}
              </h2>
              <p className="text-sm text-ink-secondary">{t('settings.reviewIntro')}</p>
            </div>
            {preview && preview.moreAccess.length > 0 && (
              <MoreAccess changes={preview.moreAccess} view={view} />
            )}
            {preview?.errors.map((e) => (
              <p
                key={e}
                role="alert"
                className="rounded-lg bg-bad-tint p-2.5 text-sm text-bad-text"
              >
                <bdi dir="ltr">{e}</bdi>
              </p>
            ))}
            {preview?.diff && <DiffView text={preview.diff} label={t('settings.diff')} />}
            {preview && preview.ok && preview.diff === '' && (
              <p className="text-sm text-ink-secondary">{t('settings.noChange')}</p>
            )}
            {problem && (
              <p role="alert" className="text-sm font-semibold text-bad-text">
                {problem}
              </p>
            )}
            {phase === 'confirm' ? (
              <div className="rounded-lg bg-primary-tint p-3">
                <p className="font-semibold">{t('settings.confirm')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={primary}
                    onClick={() =>
                      void restartThen(post('settings/apply', { patch, base: preview?.base }))
                    }
                  >
                    {t('settings.confirmYes')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => {
                      setPhase('edit');
                    }}
                  >
                    {t('approval.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={!preview?.ok || preview.diff === '' || phase === 'saving'}
                  onClick={() => {
                    setPhase('confirm');
                  }}
                >
                  {t('settings.save')}
                </button>
                <button
                  type="button"
                  className={secondary}
                  onClick={() => {
                    setPatch({});
                    setProblem(null);
                  }}
                >
                  {t('settings.discard')}
                </button>
              </div>
            )}
            <p className="text-xs text-ink-secondary">{t('settings.saveHint')}</p>
          </aside>
        )}
      </div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-xl border border-line bg-raised p-5">
      <legend className="px-1.5 text-base font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p id={id} className="font-medium">
          {label}
        </p>
        {hint && <p className="text-sm text-ink-secondary">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        className={`relative h-6 w-11 shrink-0 rounded-full disabled:opacity-60 ${checked ? 'bg-primary' : 'bg-line-strong'}`}
        onClick={() => {
          onChange(!checked);
        }}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
            checked ? 'end-0.5' : 'start-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function useText() {
  const { lang } = useI18n();
  return (text: Localized) => text[lang];
}

function ConnectorList({
  view,
  live,
  patch,
  onOpen,
}: {
  view: SettingsView;
  live: ConnectorView[];
  patch: SettingsPatch;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const text = useText();
  const enabled = (c: ConnectorSettings) => patch.connectors?.[c.id]?.enabled ?? c.enabled;
  const on = view.connectors.filter(enabled);
  const off = view.connectors.filter((c) => !enabled(c));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="on-title">
        <h2 id="on-title" className="mb-3 text-lg font-semibold">
          {t('settings.connected', { n: on.length })}
        </h2>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5">
          {on.map((c) => {
            const state = live.find((l) => l.id === c.id);
            const access = patch.connectors?.[c.id]?.access ?? c.access;
            return (
              <li key={c.id}>
                <article className="flex h-full flex-col gap-2.5 rounded-xl border border-line bg-raised p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold">{c.name}</h3>
                    {state ? (
                      <Badge tone={state.available ? 'ok' : 'bad'}>
                        {t(state.available ? 'settings.ready' : 'overview.unavailable')}
                      </Badge>
                    ) : (
                      <Badge tone="accent">{t('settings.afterSave')}</Badge>
                    )}
                  </div>
                  <p className="text-[13px] text-ink-secondary">{text(c.description)}</p>
                  {access && (
                    <span className="self-start">
                      <Badge tone={access === 'read-write-approved' ? 'accent' : 'plain'}>
                        {t(`access.${access}` as MessageKey)}
                      </Badge>
                    </span>
                  )}
                  <button
                    type="button"
                    className="mt-auto inline-flex h-8 items-center gap-1 self-start rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-muted"
                    aria-label={t('settings.configure', { name: c.name })}
                    onClick={() => {
                      onOpen(c.id);
                    }}
                  >
                    {t('settings.configureShort')}
                    <Icon name="chevronRight" size={14} className="rtl:-scale-x-100" />
                  </button>
                </article>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="add-title">
        <h2 id="add-title" className="mb-3 text-lg font-semibold">
          {t('settings.add')}
        </h2>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {off.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={c.status === 'coming-soon'}
                className="flex h-full w-full flex-col gap-1 rounded-xl border border-dashed border-line-strong bg-raised p-3.5 text-start hover:border-primary disabled:opacity-60"
                onClick={() => {
                  onOpen(c.id);
                }}
              >
                <span className="font-semibold">{c.name}</span>
                <span className="text-[13px] text-ink-secondary">
                  {c.status === 'coming-soon' ? t('settings.comingSoon') : text(c.description)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ConnectorEditor({
  connector: c,
  live,
  patch,
  canEdit,
  onChange,
  onBack,
  onSecretSaved,
  onSignedOut,
}: {
  connector: ConnectorSettings;
  live: ConnectorView | undefined;
  patch: { enabled?: boolean; access?: string; config?: Record<string, unknown> };
  canEdit: boolean;
  onChange: (change: {
    enabled?: boolean;
    access?: string;
    config?: Record<string, unknown>;
  }) => void;
  onBack: () => void;
  onSecretSaved: (action: Promise<unknown>) => void;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const text = useText();
  const enabled = patch.enabled ?? c.enabled;
  const access = patch.access ?? c.access ?? c.accessLevels[0] ?? null;
  const value = (key: string) =>
    patch.config && key in patch.config ? patch.config[key] : c.config[key];
  const [results, setResults] = useState<CheckRow[] | null>(null);
  const [testing, setTesting] = useState(false);

  const test = () => {
    setTesting(true);
    post<{ results: CheckRow[] }>('settings/test', { connector: c.id })
      .then((r) => {
        setResults(r.results);
      })
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
      })
      .finally(() => {
        setTesting(false);
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t('settings.breadcrumb')} className="text-sm text-ink-secondary">
        <button type="button" className="text-primary-text hover:underline" onClick={onBack}>
          {t('settings.tab.connectors')}
        </button>{' '}
        <span aria-hidden="true">›</span> <span aria-current="page">{c.name}</span>
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">{c.name}</h2>
        <div className="flex flex-wrap items-center gap-3">
          {c.enabled && (
            <button type="button" className={secondary} disabled={testing} onClick={test}>
              {testing && <Icon name="spinner" size={16} className="animate-spin" />}
              {t('settings.test')}
            </button>
          )}
        </div>
      </div>
      <p className="-mt-2 text-ink-secondary">{text(c.description)}</p>

      {results && (
        <ul
          aria-label={t('settings.testResults')}
          className="flex flex-col gap-1.5 rounded-xl border border-line bg-raised p-3 text-sm"
        >
          {results.map((r) => (
            <li key={r.check} className="flex flex-wrap items-center gap-2">
              <Badge tone={r.status === 'pass' ? 'ok' : r.status === 'fail' ? 'bad' : 'plain'}>
                {t(`settings.check.${r.status}` as MessageKey)}
              </Badge>
              <Ltr>{r.check}</Ltr>
              <span dir="auto" className="text-ink-secondary">
                {r.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {live && !live.available && (
        <p role="note" className="rounded-xl bg-bad-tint p-3 text-sm text-bad-text">
          <strong>{t('connectors.reason')}:</strong> <bdi dir="ltr">{live.reason}</bdi>
          {live.hint && (
            <>
              <br />
              {live.hint}
            </>
          )}
        </p>
      )}

      <Card title={t('settings.connector.state')}>
        <Toggle
          label={t('settings.connector.enabled')}
          checked={enabled}
          disabled={!canEdit}
          onChange={(v) => {
            onChange({ enabled: v });
          }}
        />
      </Card>

      {enabled && c.accessLevels.length > 0 && (
        <Card title={t('settings.connector.access')}>
          <div
            role="radiogroup"
            aria-label={t('settings.connector.access')}
            className="flex flex-col gap-2.5"
          >
            {c.accessLevels.map((level) => (
              <label
                key={level}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3.5 ${
                  access === level ? 'border-2 border-primary bg-primary-tint' : 'border-line'
                }`}
              >
                <input
                  type="radio"
                  name={`access-${c.id}`}
                  className="mt-1"
                  checked={access === level}
                  disabled={!canEdit}
                  onChange={() => {
                    onChange({ access: level });
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{t(`access.${level}` as MessageKey)}</span>
                  {(c.summaries[level] ?? []).map((s) => (
                    <span key={s.en} className="text-sm text-ink-secondary">
                      {text(s)}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
        </Card>
      )}

      {enabled && c.fields.length > 0 && (
        <Card title={t('settings.connector.where')}>
          {c.fields.map((f) => (
            <FieldEditor
              key={f.key}
              field={f}
              value={value(f.key)}
              disabled={!canEdit}
              onChange={(v) => {
                onChange({ config: { [f.key]: v } });
              }}
            />
          ))}
        </Card>
      )}

      {enabled && c.secrets.length > 0 && (
        <Card title={t('settings.connector.secrets')}>
          {c.secrets.map((s) => (
            <SecretEditor
              key={s.key}
              connector={c.id}
              secret={s}
              canEdit={canEdit && c.enabled}
              onSaved={onSecretSaved}
            />
          ))}
        </Card>
      )}

      {enabled && (
        <details className="rounded-xl border border-line bg-raised p-4">
          <summary className="cursor-pointer font-semibold">
            {t('settings.connector.tools', { read: c.tools.read, write: c.tools.write })}
          </summary>
          {live?.available ? (
            <ConnectorTools connector={live} />
          ) : (
            <p className="mt-2 text-sm text-ink-secondary">{t('settings.connector.toolsLater')}</p>
          )}
        </details>
      )}
    </div>
  );
}

function FieldEditor({
  field: f,
  value,
  disabled,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const text = useText();
  const id = useId();
  const label = (
    <label htmlFor={id} className="font-medium">
      {text(f.description)}
      {f.required && <span className="text-bad-text"> *</span>}
    </label>
  );
  if (f.kind === 'string-list') {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <TagInput
          id={id}
          values={Array.isArray(value) ? value.map(String) : []}
          placeholder={f.example?.[0] ?? ''}
          disabled={disabled}
          onChange={onChange}
        />
        {f.patternHint && <span className="text-xs text-ink-secondary">{text(f.patternHint)}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      <input
        id={id}
        className={input}
        dir="ltr"
        type={f.kind === 'integer' ? 'number' : f.kind === 'url' ? 'url' : 'text'}
        {...(f.kind === 'integer' ? { min: f.min, max: f.max } : {})}
        placeholder={f.kind === 'integer' ? '' : (f.example ?? '')}
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : f.kind === 'integer' ? Number(raw) : raw);
        }}
      />
      {f.kind === 'string' && f.patternHint && (
        <span className="text-xs text-ink-secondary">{text(f.patternHint)}</span>
      )}
      {f.kind === 'integer' && (
        <span className="text-xs text-ink-secondary">
          {t('settings.range', { min: f.min, max: f.max })}
        </span>
      )}
    </div>
  );
}

function TagInput({
  id,
  values,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  values: string[];
  placeholder: string;
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = draft.trim().replace(/,$/, '');
    if (next && !values.includes(next)) onChange([...values, next]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface p-2">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-raised py-0.5 ps-2.5 pe-1 font-mono text-[12.5px]"
        >
          <bdi dir="ltr">{v}</bdi>
          {!disabled && (
            <button
              type="button"
              aria-label={t('settings.remove', { value: v })}
              className="inline-flex size-5 items-center justify-center rounded-full text-ink-secondary hover:bg-muted"
              onClick={() => {
                onChange(values.filter((x) => x !== v));
              }}
            >
              <Icon name="x" size={12} strokeWidth={2.5} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          id={id}
          dir="ltr"
          className="h-7 min-w-40 flex-1 bg-transparent text-sm outline-none"
          placeholder={placeholder ? t('settings.addHint', { example: placeholder }) : ''}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}

function SecretEditor({
  connector,
  secret: s,
  canEdit,
  onSaved,
}: {
  connector: string;
  secret: ConnectorSettings['secrets'][number];
  canEdit: boolean;
  onSaved: (action: Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const text = useText();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const save = async () => {
    setChecking(true);
    setProblem(null);
    try {
      const action = post('settings/secret', { connector, key: s.key, value });
      await action;
      setValue('');
      onSaved(Promise.resolve());
    } catch (e) {
      const check = e instanceof ApiError ? e.message : String(e);
      setProblem(check);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <Icon name="key" size={18} className="text-ink-secondary" />
          <span className="flex flex-col">
            <span className="font-medium">{s.label}</span>
            <span className="text-xs text-ink-secondary">
              {s.set ? t('settings.secret.set') : t('settings.secret.missing')} ·{' '}
              <bdi dir="ltr" className="font-mono">
                {s.ref}
              </bdi>
            </span>
          </span>
        </span>
        {canEdit && s.writable && !editing && (
          <button
            type="button"
            className={secondary}
            onClick={() => {
              setEditing(true);
            }}
          >
            {t(s.set ? 'settings.secret.replace' : 'settings.secret.add')}
          </button>
        )}
      </div>
      {!s.writable && (
        <p className="text-sm text-ink-secondary">{t('settings.secret.file', { path: s.ref })}</p>
      )}
      <p className="text-sm text-ink-secondary">{text(s.howToCreate)}</p>
      {editing && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={id} className="text-sm font-medium">
            {t('settings.secret.new', { label: s.label })}
          </label>
          <input
            id={id}
            type="password"
            autoComplete="off"
            dir="ltr"
            className={input}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
          <p className="text-xs text-ink-secondary">{t('settings.secret.hint')}</p>
          {problem && (
            <p role="alert" className="text-sm font-semibold text-bad-text">
              {t('settings.secret.failed', { message: problem })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={primary}
              disabled={checking || value.trim().length < 4}
            >
              {checking && <Icon name="spinner" size={16} className="animate-spin" />}
              {t('settings.secret.save')}
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => {
                setEditing(false);
                setValue('');
                setProblem(null);
              }}
            >
              {t('approval.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PolicyEditor({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: (change: NonNullable<SettingsPatch['policy']>) => void;
}) {
  const { t } = useI18n();
  const approversId = useId();
  const expiryId = useId();
  const destructive = patch.policy?.destructiveActions ?? view.policy.destructiveActions;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.policy.approvers')}>
        <label htmlFor={approversId} className="text-sm text-ink-secondary">
          {t('settings.policy.approversHint')}
        </label>
        <TagInput
          id={approversId}
          values={patch.policy?.approvers ?? view.policy.approvers}
          placeholder="console:name"
          disabled={!canEdit}
          onChange={(approvers) => {
            onChange({ approvers });
          }}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={expiryId} className="font-medium">
            {t('settings.policy.expiry')}
          </label>
          <input
            id={expiryId}
            type="number"
            min={1}
            max={1440}
            className={`${input} max-w-40`}
            value={patch.policy?.expiresAfterMinutes ?? view.policy.expiresAfterMinutes}
            disabled={!canEdit}
            onChange={(e) => {
              onChange({ expiresAfterMinutes: Number(e.target.value) });
            }}
          />
        </div>
      </Card>
      <Card title={t('settings.policy.destructive')}>
        <div
          role="radiogroup"
          aria-label={t('settings.policy.destructive')}
          className="flex flex-col gap-2.5"
        >
          {(['deny', 'require-approval'] as const).map((d) => (
            <label
              key={d}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3.5 ${
                destructive === d ? 'border-2 border-primary bg-primary-tint' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="destructive"
                className="mt-1"
                checked={destructive === d}
                disabled={!canEdit}
                onChange={() => {
                  onChange({ destructiveActions: d });
                }}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold">{t(`settings.policy.${d}` as MessageKey)}</span>
                <span className="text-sm text-ink-secondary">
                  {t(`settings.policy.${d}Hint` as MessageKey)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | '';
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        className={`${input} max-w-48`}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value === '' ? null : Number(e.target.value));
        }}
      />
      {hint && <span className="text-xs text-ink-secondary">{hint}</span>}
    </div>
  );
}

function LimitsEditor({
  view,
  patch,
  canEdit,
  onModel,
  onLimits,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onModel: (change: NonNullable<SettingsPatch['model']>) => void;
  onLimits: (change: NonNullable<SettingsPatch['limits']>) => void;
}) {
  const { t } = useI18n();
  const modelId = useId();
  const limits = { ...view.limits, ...patch.limits };
  const budget = limits.monthlyBudgetUsd;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('settings.limits.model')}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={modelId} className="font-medium">
            {t('settings.limits.modelName', { provider: view.model.provider })}
          </label>
          <input
            id={modelId}
            dir="ltr"
            className={`${input} max-w-sm`}
            value={patch.model?.name ?? view.model.name}
            disabled={!canEdit}
            onChange={(e) => {
              onModel({ name: e.target.value });
            }}
          />
        </div>
      </Card>
      <Card title={t('settings.limits.perQuestion')}>
        <NumberField
          label={t('settings.limits.maxSteps')}
          value={limits.maxSteps}
          min={1}
          max={50}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onLimits({ maxSteps: v });
          }}
        />
        <NumberField
          label={t('settings.limits.tokenBudget')}
          hint={t('settings.limits.tokenBudgetHint')}
          value={limits.tokenBudget}
          min={10_000}
          max={5_000_000}
          step={10_000}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onLimits({ tokenBudget: v });
          }}
        />
        <NumberField
          label={t('settings.limits.timeout')}
          value={limits.timeoutMinutes}
          min={1}
          max={60}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onLimits({ timeoutMinutes: v });
          }}
        />
      </Card>
      <Card title={t('settings.limits.budget')}>
        <NumberField
          label={t('settings.limits.budgetLabel')}
          hint={t('settings.limits.budgetHint')}
          value={budget === null || budget === undefined ? '' : budget}
          min={1}
          max={1_000_000}
          disabled={!canEdit}
          onChange={(v) => {
            onLimits({ monthlyBudgetUsd: v });
          }}
        />
      </Card>
    </div>
  );
}

function MoreAccess({ changes, view }: { changes: AccessChange[]; view: SettingsView | null }) {
  const { t } = useI18n();
  const name = (id: string) => view?.connectors.find((c) => c.id === id)?.name ?? id;
  const lines = useMemo(
    () =>
      changes.map((c) => {
        switch (c.code) {
          case 'enabled':
            return t('settings.more.enabled', { connector: name(c.connector) });
          case 'write':
            return t('settings.more.write', { connector: name(c.connector) });
          case 'scope':
            return t('settings.more.scope', {
              connector: name(c.connector),
              added: c.added.join(', '),
            });
          case 'approver':
            return t('settings.more.approver', { approver: c.approver });
          case 'destructive':
            return t('settings.more.destructive');
          case 'chat':
            return t('settings.more.chat');
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, t, view],
  );
  return (
    <div role="note" className="flex gap-2.5 rounded-lg bg-bad-tint p-3 text-sm text-bad-text">
      <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-semibold">{t('settings.more.title')}</p>
        <ul className="mt-1 list-disc ps-4">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
