import { useId, useState } from 'react';
import {
  ApiError,
  post,
  SignedOut,
  type AuditChain,
  type CheckScheduleConfig,
  type DoctorRow,
  type Environment,
  type Freeze,
  type SettingsPatch,
  type SettingsView,
} from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { Card, input, NumberField, primary, secondary, TagInput, Toggle } from './settings.tsx';
import { Badge, Mono } from './ui.tsx';

/**
 * The rest of kodra-agent.yaml in the console (M30b): profile and approval rules,
 * environments with their freezes, checks and alert limits, the proxy and image mirrors,
 * data protection, named models, observability, and health. Every edit goes through the same
 * preview, diff, and save as the rest of Settings.
 */

type Change = (patch: SettingsPatch) => void;

/** A copy without some keys. */
function without<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !(keys as PropertyKey[]).includes(k)),
  ) as Omit<T, K>;
}

const PROFILES = ['starter', 'team', 'strict'] as const;
const DETECTORS = ['cards', 'ibans', 'emails', 'phones'] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const PROVIDERS = ['anthropic', 'openai', 'azure-openai', 'bedrock', 'ollama'] as const;

const small = 'h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm';
const remove =
  'inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm hover:bg-muted disabled:opacity-50';

function Field({
  label,
  value,
  placeholder,
  disabled,
  onChange,
  wide = false,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 ${wide ? 'min-w-[260px] flex-1' : ''}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        className={small}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function Tags({
  label,
  values,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <TagInput
        id={id}
        values={values}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

/** Profile and the approval rules it would otherwise decide (in Approvals and policy). */
export function ProfileRules({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  const profile = patch.profile ?? view.profile;
  const rule = <K extends keyof SettingsView['rules']>(key: K) =>
    patch.policy && key in patch.policy
      ? (patch.policy[key] ?? undefined)
      : (view.rules[key] ?? undefined);
  const setRule = (change: NonNullable<SettingsPatch['policy']>) => {
    onChange({ policy: { ...patch.policy, ...change } });
  };
  return (
    <Card title={t('more.profile.title')}>
      <div role="radiogroup" aria-label={t('more.profile.title')} className="flex flex-col gap-2">
        {PROFILES.map((p) => (
          <label
            key={p}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
              profile === p ? 'border-2 border-primary bg-primary-tint' : 'border-line'
            }`}
          >
            <input
              type="radio"
              name="profile"
              className="mt-1"
              checked={profile === p}
              disabled={!canEdit}
              onChange={() => {
                onChange({ profile: p });
              }}
            />
            <span className="flex flex-col">
              <span className="font-semibold">{t(`more.profile.${p}` as MessageKey)}</span>
              <span className="text-sm text-ink-secondary">
                {t(`more.profile.${p}Hint` as MessageKey)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-sm text-ink-secondary">{t('more.rules.intro')}</p>
      <NumberField
        label={t('more.rules.minApprovers')}
        hint={t('more.rules.profileDefault')}
        value={rule('minApprovers') ?? ''}
        min={1}
        max={5}
        disabled={!canEdit}
        onChange={(v) => {
          setRule({ minApprovers: v });
        }}
      />
      <Toggle
        label={t('more.rules.selfApproval')}
        hint={t('more.rules.selfApprovalHint')}
        checked={rule('allowSelfApproval') ?? profile === 'starter'}
        disabled={!canEdit}
        onChange={(v) => {
          setRule({ allowSelfApproval: v });
        }}
      />
      <Toggle
        label={t('more.rules.changeRef')}
        hint={t('more.rules.changeRefHint')}
        checked={rule('requireChangeRef') ?? false}
        disabled={!canEdit}
        onChange={(v) => {
          setRule({ requireChangeRef: v });
        }}
      />
      {(rule('requireChangeRef') ?? false) && (
        <Field
          label={t('more.rules.pattern')}
          value={rule('changeRefPattern') ?? ''}
          placeholder="^CHG[0-9]{7}$"
          disabled={!canEdit}
          onChange={(v) => {
            setRule({ changeRefPattern: v === '' ? null : v });
          }}
        />
      )}
    </Card>
  );
}

const emptyEnvironment = (): Environment => ({
  name: '',
  production: false,
  namespaces: [],
  repos: [],
  freezes: [],
});

/** Environments (M10) and their freezes (M11). */
export function EnvironmentsEditor({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  const envs = patch.environments ?? view.environments;
  const set = (next: Environment[]) => {
    onChange({ environments: next });
  };
  const update = (i: number, change: Partial<Environment>) => {
    set(envs.map((e, j) => (i === j ? { ...e, ...change } : e)));
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">{t('more.env.intro')}</p>
      {envs.map((env, i) => (
        <Card key={i} title={env.name || t('more.env.new')}>
          <div className="flex flex-wrap gap-3">
            <Field
              label={t('more.env.name')}
              value={env.name}
              placeholder="production"
              disabled={!canEdit}
              onChange={(name) => {
                update(i, { name });
              }}
            />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('more.env.model')}</span>
              <select
                aria-label={t('more.env.model')}
                className={small}
                value={env.model ?? ''}
                disabled={!canEdit}
                onChange={(e) => {
                  const rest = without(env, 'model');
                  set(
                    envs.map((x, j) =>
                      i === j ? (e.target.value ? { ...rest, model: e.target.value } : rest) : x,
                    ),
                  );
                }}
              >
                <option value="">{t('more.env.mainModel')}</option>
                {view.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Toggle
            label={t('more.env.production')}
            hint={t('more.env.productionHint')}
            checked={env.production}
            disabled={!canEdit}
            onChange={(production) => {
              update(i, { production });
            }}
          />
          <Tags
            label={t('more.env.namespaces')}
            values={env.namespaces}
            placeholder="payments"
            disabled={!canEdit}
            onChange={(namespaces) => {
              update(i, { namespaces });
            }}
          />
          <Tags
            label={t('more.env.repos')}
            values={env.repos}
            placeholder="group/project"
            disabled={!canEdit}
            onChange={(repos) => {
              update(i, { repos });
            }}
          />
          <Tags
            label={t('more.env.approvers')}
            values={env.approvers ?? []}
            placeholder="console:name or @slack-name"
            disabled={!canEdit}
            onChange={(approvers) => {
              const rest = without(env, 'approvers');
              set(
                envs.map((x, j) =>
                  i === j ? (approvers.length ? { ...rest, approvers } : rest) : x,
                ),
              );
            }}
          />
          <NumberField
            label={t('more.rules.minApprovers')}
            hint={t('more.rules.profileDefault')}
            value={env.approvals?.minApprovers ?? ''}
            min={1}
            max={5}
            disabled={!canEdit}
            onChange={(v) => {
              const approvals = { ...env.approvals };
              if (v === null) delete approvals.minApprovers;
              else approvals.minApprovers = v;
              update(i, { approvals });
            }}
          />
          <FreezesEditor
            freezes={env.freezes}
            canEdit={canEdit}
            onChange={(freezes) => {
              update(i, { freezes });
            }}
          />
          <button
            type="button"
            className={`${remove} self-start`}
            disabled={!canEdit}
            onClick={() => {
              set(envs.filter((_, j) => j !== i));
            }}
          >
            {t('more.env.remove')}
          </button>
        </Card>
      ))}
      <button
        type="button"
        className={`${secondary} self-start`}
        disabled={!canEdit}
        onClick={() => {
          set([...envs, emptyEnvironment()]);
        }}
      >
        <Icon name="plus" size={16} />
        {t('more.env.add')}
      </button>
    </div>
  );
}

function FreezesEditor({
  freezes,
  canEdit,
  onChange,
}: {
  freezes: Freeze[];
  canEdit: boolean;
  onChange: (freezes: Freeze[]) => void;
}) {
  const { t } = useI18n();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const update = (i: number, f: Freeze) => {
    onChange(freezes.map((x, j) => (i === j ? f : x)));
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">{t('more.freeze.title')}</span>
      <span className="text-sm text-ink-secondary">{t('more.freeze.intro')}</span>
      {freezes.map((f, i) => {
        const weekly = f.weekly !== undefined;
        const range = f.weekly ?? f.dates ?? { from: '', to: '' };
        const setRange = (from: string, to: string) => {
          const rest = without(f, 'weekly', 'dates');
          update(i, weekly ? { ...rest, weekly: { from, to } } : { ...rest, dates: { from, to } });
        };
        return (
          <div
            key={i}
            className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2.5"
          >
            <Field
              label={t('more.freeze.name')}
              value={f.name}
              placeholder="weekend"
              disabled={!canEdit}
              onChange={(name) => {
                update(i, { ...f, name });
              }}
            />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('more.freeze.kind')}</span>
              <select
                aria-label={t('more.freeze.kind')}
                className={small}
                value={weekly ? 'weekly' : 'dates'}
                disabled={!canEdit}
                onChange={(e) => {
                  const rest = without(f, 'weekly', 'dates');
                  update(
                    i,
                    e.target.value === 'weekly'
                      ? { ...rest, weekly: { from: 'Fri 18:00', to: 'Sun 08:00' } }
                      : { ...rest, dates: { from: '', to: '' } },
                  );
                }}
              >
                <option value="weekly">{t('more.freeze.weekly')}</option>
                <option value="dates">{t('more.freeze.dates')}</option>
              </select>
            </div>
            <Field
              label={t('more.freeze.from')}
              value={range.from}
              placeholder={weekly ? 'Fri 18:00' : '2026-12-24'}
              disabled={!canEdit}
              onChange={(from) => {
                setRange(from, range.to);
              }}
            />
            <Field
              label={t('more.freeze.to')}
              value={range.to}
              placeholder={weekly ? 'Sun 08:00' : '2027-01-02'}
              disabled={!canEdit}
              onChange={(to) => {
                setRange(range.from, to);
              }}
            />
            <Field
              label={t('more.zone')}
              value={f.timezone}
              placeholder={zone}
              disabled={!canEdit}
              onChange={(timezone) => {
                update(i, { ...f, timezone });
              }}
            />
            <button
              type="button"
              className={remove}
              disabled={!canEdit}
              onClick={() => {
                onChange(freezes.filter((_, j) => j !== i));
              }}
            >
              {t('more.remove')}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={`${remove} self-start`}
        disabled={!canEdit}
        onClick={() => {
          onChange([
            ...freezes,
            { name: '', timezone: zone, weekly: { from: 'Fri 18:00', to: 'Sun 08:00' } },
          ]);
        }}
      >
        {t('more.freeze.add')}
      </button>
    </div>
  );
}

/** When the checks run (M27), and the limits on alert investigations (M5). */
export function ChecksEditor({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  const schedules = patch.checks?.schedules ?? view.checks.schedules;
  const quiet = patch.checks?.quietWhenClean ?? view.checks.quietWhenClean;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const setSchedules = (next: CheckScheduleConfig[]) => {
    onChange({ checks: { ...patch.checks, schedules: next } });
  };
  const update = (i: number, change: Partial<CheckScheduleConfig>) => {
    setSchedules(schedules.map((s, j) => (i === j ? { ...s, ...change } : s)));
  };
  const monitoring = { ...view.monitoring, ...patch.monitoring };
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('more.checks.title')}>
        <p className="text-sm text-ink-secondary">{t('more.checks.intro')}</p>
        {schedules.map((s, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label={t('more.checks.name')}
                value={s.name}
                placeholder="daily"
                disabled={!canEdit}
                onChange={(name) => {
                  update(i, { name });
                }}
              />
              <Field
                label={t('more.checks.at')}
                value={s.at}
                placeholder="09:00"
                disabled={!canEdit}
                onChange={(at) => {
                  update(i, { at });
                }}
              />
              <Field
                label={t('more.zone')}
                value={s.timezone}
                placeholder={zone}
                disabled={!canEdit}
                onChange={(timezone) => {
                  update(i, { timezone });
                }}
              />
              <button
                type="button"
                className={remove}
                disabled={!canEdit}
                onClick={() => {
                  setSchedules(schedules.filter((_, j) => j !== i));
                }}
              >
                {t('more.remove')}
              </button>
            </div>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 font-medium">{t('more.checks.days')}</legend>
              {DAYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={s.days.includes(d)}
                    disabled={!canEdit}
                    onChange={(e) => {
                      update(i, {
                        days: e.target.checked
                          ? DAYS.filter((x) => x === d || s.days.includes(x))
                          : s.days.filter((x) => x !== d),
                      });
                    }}
                  />
                  {t(`more.day.${d}` as MessageKey)}
                </label>
              ))}
            </fieldset>
          </div>
        ))}
        <button
          type="button"
          className={`${remove} self-start`}
          disabled={!canEdit || schedules.length >= 10}
          onClick={() => {
            setSchedules([
              ...schedules,
              {
                name: schedules.length ? `run-${String(schedules.length + 1)}` : 'daily',
                at: '09:00',
                days: [...DAYS],
                timezone: zone,
              },
            ]);
          }}
        >
          {t('more.checks.add')}
        </button>
        <Toggle
          label={t('more.checks.quiet')}
          hint={t('more.checks.quietHint')}
          checked={quiet}
          disabled={!canEdit}
          onChange={(quietWhenClean) => {
            onChange({ checks: { ...patch.checks, quietWhenClean } });
          }}
        />
      </Card>
      <Card title={t('more.monitoring.title')}>
        <p className="text-sm text-ink-secondary">{t('more.monitoring.intro')}</p>
        <NumberField
          label={t('more.monitoring.maxConcurrent')}
          value={monitoring.maxConcurrent}
          min={1}
          max={10}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onChange({ monitoring: { ...patch.monitoring, maxConcurrent: v } });
          }}
        />
        <NumberField
          label={t('more.monitoring.maxPerHour')}
          value={monitoring.maxPerHour}
          min={1}
          max={1000}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onChange({ monitoring: { ...patch.monitoring, maxPerHour: v } });
          }}
        />
        <NumberField
          label={t('more.monitoring.cooldown')}
          value={monitoring.cooldownMinutes}
          min={1}
          max={1440}
          disabled={!canEdit}
          onChange={(v) => {
            if (v !== null) onChange({ monitoring: { ...patch.monitoring, cooldownMinutes: v } });
          }}
        />
      </Card>
    </div>
  );
}

/** Writes per hour (M29), next to the other limits. */
export function WritesCard({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  return (
    <Card title={t('more.writes.title')}>
      <NumberField
        label={t('more.writes.label')}
        hint={t('more.writes.hint')}
        value={patch.limits?.maxWritesPerHour ?? view.limits.maxWritesPerHour}
        min={1}
        max={1000}
        disabled={!canEdit}
        onChange={(v) => {
          if (v !== null) onChange({ limits: { ...patch.limits, maxWritesPerHour: v } });
        }}
      />
    </Card>
  );
}

/** Named models (M13) that environments can keep their data to. */
export function NamedModelsEditor({
  view,
  patch,
  canEdit,
  onChange,
  onKeySaved,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
  onKeySaved: (action: Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<string>('ollama');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const pending = patch.models ?? {};
  const listed = view.models.filter((m) => pending[m.name] !== null);
  const added = Object.entries(pending).flatMap(([n, m]) =>
    m && !view.models.some((v) => v.name === n) ? [[n, m] as const] : [],
  );
  return (
    <Card title={t('more.models.title')}>
      <p className="text-sm text-ink-secondary">{t('more.models.intro')}</p>
      {listed.map((m) => (
        <div key={m.name} className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <Mono>{m.name}</Mono> · {m.provider}/{m.model}
            </span>
            <button
              type="button"
              className={remove}
              disabled={!canEdit}
              onClick={() => {
                onChange({ models: { ...pending, [m.name]: null } });
              }}
            >
              {t('more.remove')}
            </button>
          </div>
          {m.secrets.map((s) => (
            <ModelKey
              key={s.key}
              model={m.name}
              secret={s}
              canEdit={canEdit}
              onSaved={onKeySaved}
            />
          ))}
        </div>
      ))}
      {added.map(([n, m]) => (
        <p key={n} className="text-sm">
          <Mono>{n}</Mono> · {m.provider}/{m.name} ({t('more.models.unsaved')})
        </p>
      ))}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line p-3">
          <Field
            label={t('more.models.name')}
            value={name}
            placeholder="local"
            disabled={false}
            onChange={setName}
          />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('more.models.provider')}</span>
            <select
              aria-label={t('more.models.provider')}
              className={small}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <Field
            label={t('more.models.model')}
            value={model}
            placeholder="llama3.1:8b"
            disabled={false}
            onChange={setModel}
          />
          {(provider === 'ollama' || provider === 'azure-openai') && (
            <Field
              label={provider === 'ollama' ? 'baseUrl' : 'endpoint'}
              value={baseUrl}
              placeholder={
                provider === 'ollama'
                  ? 'http://host.docker.internal:11434'
                  : 'https://name.openai.azure.com'
              }
              disabled={false}
              onChange={setBaseUrl}
              wide
            />
          )}
          <button
            type="button"
            className={secondary}
            disabled={!/^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/.test(name) || model.trim() === ''}
            onClick={() => {
              const config: Record<string, string> = {};
              if (baseUrl.trim())
                config[provider === 'ollama' ? 'baseUrl' : 'endpoint'] = baseUrl.trim();
              onChange({
                models: { ...pending, [name]: { provider, name: model.trim(), config } },
              });
              setName('');
              setModel('');
              setBaseUrl('');
            }}
          >
            {t('more.models.add')}
          </button>
        </div>
      )}
    </Card>
  );
}

function ModelKey({
  model,
  secret,
  canEdit,
  onSaved,
}: {
  model: string;
  secret: { key: string; label: string; set: boolean };
  canEdit: boolean;
  onSaved: (action: Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setProblem(null);
        post('settings/secret', { connector: `model:${model}`, key: secret.key, value })
          .then(() => {
            setValue('');
            onSaved(Promise.resolve());
          })
          .catch((err: unknown) => {
            setProblem(err instanceof ApiError ? err.message : String(err));
          });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {secret.label} · {secret.set ? t('settings.secret.set') : t('settings.secret.missing')}
        </label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          className={small}
          value={value}
          disabled={!canEdit}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
      </div>
      <button type="submit" className={remove} disabled={!canEdit || value.trim().length < 4}>
        {t('settings.secret.save')}
      </button>
      {problem && (
        <span role="alert" className="text-sm font-semibold text-bad-text">
          {t('settings.secret.failed', { message: problem })}
        </span>
      )}
    </form>
  );
}

/** The proxy (its URLs are secrets), hosts that skip it, and base image mirrors (M12). */
export function ProxyEditor({
  view,
  patch,
  canEdit,
  onChange,
  onSaved,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
  onSaved: (action: Promise<unknown>) => void;
}) {
  const { t } = useI18n();
  const [https, setHttps] = useState('');
  const [http, setHttp] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const writable = canEdit && view.network.proxyWritable;
  const send = (body: Record<string, unknown>) => {
    setProblem(null);
    post('settings/proxy', body)
      .then(() => {
        setHttps('');
        setHttp('');
        onSaved(Promise.resolve());
      })
      .catch((e: unknown) => {
        setProblem(e instanceof ApiError ? e.message : String(e));
      });
  };
  const noProxy =
    patch.network && 'noProxy' in patch.network
      ? (patch.network.noProxy ?? '')
      : (view.network.noProxy ?? '');
  const mirrors = Object.entries(patch.ship?.baseImageMirrors ?? view.ship.baseImageMirrors);
  const setMirrors = (next: [string, string][]) => {
    onChange({ ship: { baseImageMirrors: Object.fromEntries(next) } });
  };
  return (
    <>
      <Card title={t('more.proxy.title')}>
        <p className="text-sm text-ink-secondary">{t('more.proxy.intro')}</p>
        <p className="text-sm">
          HTTPS: {view.network.proxy.https ? t('settings.secret.set') : t('more.proxy.none')} ·
          HTTP: {view.network.proxy.http ? t('settings.secret.set') : t('more.proxy.none')}
        </p>
        {writable && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send({ ...(https ? { https } : {}), ...(http ? { http } : {}) });
            }}
          >
            <div className="flex flex-wrap gap-2">
              <PasswordField label={t('more.proxy.https')} value={https} onChange={setHttps} />
              <PasswordField label={t('more.proxy.http')} value={http} onChange={setHttp} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primary} disabled={!https && !http}>
                {t('more.proxy.save')}
              </button>
              {(view.network.proxy.https || view.network.proxy.http) && (
                <button
                  type="button"
                  className={secondary}
                  onClick={() => {
                    send({ https: null, http: null });
                  }}
                >
                  {t('more.proxy.remove')}
                </button>
              )}
            </div>
          </form>
        )}
        {problem && (
          <p role="alert" className="text-sm font-semibold text-bad-text">
            {t('settings.secret.failed', { message: problem })}
          </p>
        )}
        <Field
          label={t('more.proxy.noProxy')}
          value={noProxy}
          placeholder="localhost,.svc,.cluster.local"
          disabled={!canEdit}
          onChange={(v) => {
            onChange({ network: { noProxy: v === '' ? null : v } });
          }}
          wide
        />
      </Card>
      <Card title={t('more.mirrors.title')}>
        <p className="text-sm text-ink-secondary">{t('more.mirrors.intro')}</p>
        {mirrors.map(([from, to], i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field
              label={t('more.mirrors.from')}
              value={from}
              placeholder="docker.io"
              disabled={!canEdit}
              onChange={(v) => {
                setMirrors(mirrors.map((m, j) => (i === j ? [v, m[1]] : m)));
              }}
            />
            <Field
              label={t('more.mirrors.to')}
              value={to}
              placeholder="harbor.example.com/mirror"
              disabled={!canEdit}
              onChange={(v) => {
                setMirrors(mirrors.map((m, j) => (i === j ? [m[0], v] : m)));
              }}
              wide
            />
            <button
              type="button"
              className={remove}
              disabled={!canEdit}
              onClick={() => {
                setMirrors(mirrors.filter((_, j) => j !== i));
              }}
            >
              {t('more.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${remove} self-start`}
          disabled={!canEdit}
          onClick={() => {
            setMirrors([...mirrors, ['', '']]);
          }}
        >
          {t('more.mirrors.add')}
        </button>
      </Card>
    </>
  );
}

function PasswordField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-[260px] flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        className={input}
        placeholder="http://user:password@proxy.example.com:3128"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

/** What the redactor masks before the model sees it (M13). */
export function PrivacyEditor({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  const redact =
    patch.dataProtection && 'redact' in patch.dataProtection
      ? (patch.dataProtection.redact ?? null)
      : view.dataProtection.redact;
  const active = redact ?? view.dataProtection.defaults;
  const patterns = patch.dataProtection?.patterns ?? view.dataProtection.patterns;
  const setPatterns = (next: { name: string; regex: string }[]) => {
    onChange({ dataProtection: { ...patch.dataProtection, patterns: next } });
  };
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('more.privacy.title')}>
        <p className="text-sm text-ink-secondary">{t('more.privacy.intro')}</p>
        <Toggle
          label={t('more.privacy.profile')}
          hint={t('more.privacy.profileHint', {
            list: view.dataProtection.defaults.join(', ') || '-',
          })}
          checked={redact === null}
          disabled={!canEdit}
          onChange={(useProfile) => {
            onChange({
              dataProtection: {
                ...patch.dataProtection,
                redact: useProfile ? null : [...view.dataProtection.defaults],
              },
            });
          }}
        />
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 font-medium">{t('more.privacy.mask')}</legend>
          {DETECTORS.map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={active.includes(d)}
                disabled={!canEdit || redact === null}
                onChange={(e) => {
                  onChange({
                    dataProtection: {
                      ...patch.dataProtection,
                      redact: e.target.checked
                        ? DETECTORS.filter((x) => x === d || active.includes(x))
                        : active.filter((x) => x !== d),
                    },
                  });
                }}
              />
              {t(`more.privacy.${d}` as MessageKey)}
            </label>
          ))}
        </fieldset>
      </Card>
      <Card title={t('more.patterns.title')}>
        <p className="text-sm text-ink-secondary">{t('more.patterns.intro')}</p>
        {patterns.map((p, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field
              label={t('more.patterns.name')}
              value={p.name}
              placeholder="order-id"
              disabled={!canEdit}
              onChange={(name) => {
                setPatterns(patterns.map((x, j) => (i === j ? { ...x, name } : x)));
              }}
            />
            <Field
              label={t('more.patterns.regex')}
              value={p.regex}
              placeholder="ORD-[0-9]{8}"
              disabled={!canEdit}
              onChange={(regex) => {
                setPatterns(patterns.map((x, j) => (i === j ? { ...x, regex } : x)));
              }}
              wide
            />
            <button
              type="button"
              className={remove}
              disabled={!canEdit}
              onClick={() => {
                setPatterns(patterns.filter((_, j) => j !== i));
              }}
            >
              {t('more.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${remove} self-start`}
          disabled={!canEdit}
          onClick={() => {
            setPatterns([...patterns, { name: '', regex: '' }]);
          }}
        >
          {t('more.patterns.add')}
        </button>
      </Card>
    </div>
  );
}

/** The agent's own metrics, traces, and audit lines (M14). */
export function ObservabilityEditor({
  view,
  patch,
  canEdit,
  onChange,
}: {
  view: SettingsView;
  patch: SettingsPatch;
  canEdit: boolean;
  onChange: Change;
}) {
  const { t } = useI18n();
  const metrics = { ...view.metrics, ...patch.metrics };
  const tracing = { ...view.tracing, ...patch.tracing };
  return (
    <Card title={t('more.obs.title')}>
      <Toggle
        label={t('more.obs.metrics')}
        hint={t('more.obs.metricsHint')}
        checked={metrics.enabled}
        disabled={!canEdit}
        onChange={(enabled) => {
          onChange({ metrics: { ...patch.metrics, enabled } });
        }}
      />
      {metrics.enabled && (
        <NumberField
          label={t('more.obs.port')}
          value={metrics.port}
          min={1024}
          max={65535}
          disabled={!canEdit}
          onChange={(port) => {
            if (port !== null) onChange({ metrics: { ...patch.metrics, port } });
          }}
        />
      )}
      <Toggle
        label={t('more.obs.tracing')}
        hint={t('more.obs.tracingHint')}
        checked={tracing.enabled}
        disabled={!canEdit}
        onChange={(enabled) => {
          onChange({ tracing: { ...patch.tracing, enabled } });
        }}
      />
      {tracing.enabled && (
        <Field
          label={t('more.obs.endpoint')}
          value={tracing.endpoint ?? ''}
          placeholder="http://otel-collector:4318/v1/traces"
          disabled={!canEdit}
          onChange={(endpoint) => {
            onChange({
              tracing: { ...patch.tracing, endpoint: endpoint === '' ? null : endpoint },
            });
          }}
          wide
        />
      )}
      <Toggle
        label={t('more.obs.stdout')}
        hint={t('more.obs.stdoutHint')}
        checked={patch.audit?.stdout ?? view.audit.stdout}
        disabled={!canEdit}
        onChange={(stdout) => {
          onChange({ audit: { stdout } });
        }}
      />
    </Card>
  );
}

/** Every doctor check and the audit chain, from the console (M30b). */
export function HealthPanel({
  canApprove,
  onSignedOut,
}: {
  canApprove: boolean;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<DoctorRow[] | null>(null);
  const [chain, setChain] = useState<AuditChain | null>(null);
  const [busy, setBusy] = useState<'doctor' | 'audit' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = (e: unknown) => {
    if (e instanceof SignedOut) onSignedOut();
    else setProblem(e instanceof ApiError ? e.message : String(e));
  };
  const tone = (s: DoctorRow['status']) => (s === 'pass' ? 'ok' : s === 'fail' ? 'bad' : 'plain');
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('more.health.doctor')}>
        <p className="text-sm text-ink-secondary">{t('more.health.doctorIntro')}</p>
        <button
          type="button"
          className={`${primary} self-start`}
          disabled={!canApprove || busy !== null}
          onClick={() => {
            setBusy('doctor');
            setProblem(null);
            post<{ rows: DoctorRow[] }>('settings/doctor', {})
              .then((r) => {
                setRows(r.rows);
              })
              .catch(failed)
              .finally(() => {
                setBusy(null);
              });
          }}
        >
          {busy === 'doctor' && <Icon name="spinner" size={16} className="animate-spin" />}
          {t('more.health.run')}
        </button>
        {rows && (
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li
                key={i}
                className="flex flex-col gap-0.5 rounded-lg border border-line p-2.5 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone(r.status)}>
                    <span>{t(`more.health.${r.status}` as MessageKey)}</span>
                  </Badge>
                  <span className="font-medium">
                    {r.component} / {r.check}
                  </span>
                </span>
                <span>{r.message}</span>
                {r.hint && r.status === 'fail' && (
                  <span className="text-ink-secondary">{r.hint}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('more.health.audit')}>
        <p className="text-sm text-ink-secondary">{t('more.health.auditIntro')}</p>
        <button
          type="button"
          className={`${secondary} self-start`}
          disabled={busy !== null}
          onClick={() => {
            setBusy('audit');
            setProblem(null);
            post<AuditChain>('settings/audit-verify', {})
              .then(setChain)
              .catch(failed)
              .finally(() => {
                setBusy(null);
              });
          }}
        >
          {t('more.health.verify')}
        </button>
        {chain && (
          <p className="text-sm" role="status">
            {chain.ok
              ? t('more.health.chainOk', { records: String(chain.records) })
              : t('more.health.chainBad', { problem: chain.problem ?? '' })}
          </p>
        )}
      </Card>
      {problem && (
        <p role="alert" className="text-sm font-semibold text-bad-text">
          {problem}
        </p>
      )}
    </div>
  );
}
