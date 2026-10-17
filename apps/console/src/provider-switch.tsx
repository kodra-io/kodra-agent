import { useCallback, useId, useState, type ReactNode } from 'react';
import { get, post, type ConfigField, type ModelOptionsView, type ProviderView } from './api.ts';
import { useI18n } from './i18n.tsx';
import { useLoad } from './load.ts';
import { Badge, Ltr } from './ui.tsx';

const input =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 disabled:opacity-60';
const secondary =
  'inline-flex h-9 items-center rounded-lg border border-line-strong bg-raised px-3 text-sm font-medium hover:bg-muted disabled:opacity-50';
const primary =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-white shadow-md hover:bg-primary-deep disabled:opacity-50';

interface CheckResult {
  checks: { check: string; status: string; message: string }[];
  models: ModelOptionsView;
}

/**
 * Switching the model provider, rendered from the provider manifests: pick a provider, fill
 * its settings and key, Check (the provider's own check with that key, and its models), pick
 * a model, then Switch. The agent tries the model once more with the new key before it saves
 * anything; the key goes to .env and is never shown again.
 */
export function ProviderSwitch({
  current,
  base,
  renderField,
  onSwitch,
  onCancel,
  onSignedOut,
}: {
  current: string;
  base: string;
  renderField: (field: ConfigField, value: string, onChange: (v: string) => void) => ReactNode;
  onSwitch: (action: Promise<unknown>) => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const { t, lang, num } = useI18n();
  const group = useId();
  const secretId = useId();
  const load = useCallback(() => get<ProviderView[]>('settings/providers'), []);
  const { data: providers, error } = useLoad(load, onSignedOut);
  const [chosen, setChosen] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [model, setModel] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (n: number) => num(n, { style: 'currency', currency: 'USD' });

  if (error) return <p role="alert">{t('app.error', { message: error })}</p>;
  if (!providers) return <p>{t('app.loading')}</p>;
  const provider = providers.find((p) => p.id === chosen) ?? null;
  const key = provider?.secrets[0];
  const candidate = () => ({
    provider: provider?.id ?? '',
    name: model,
    config,
    secrets: key && secret !== '' ? { [key.key]: secret } : {},
  });
  const pick = (p: ProviderView) => {
    setChosen(p.id);
    setConfig(p.config);
    setSecret('');
    setModel('');
    setCheck(null);
    setProblem(null);
  };
  const runCheck = async () => {
    setBusy(true);
    setProblem(null);
    setCheck(null);
    try {
      const result = await post<CheckResult>('settings/provider-check', candidate());
      setCheck(result);
      setModel(result.models.options.find((o) => o.available !== false)?.name ?? '');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const needsKey = Boolean(key && !key.set && secret === '');

  return (
    <section
      aria-labelledby={`${group}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id={`${group}-title`} className="font-semibold">
        {t('provider.title')}
      </h2>
      <div
        role="radiogroup"
        aria-label={t('provider.choose')}
        className="grid gap-2 sm:grid-cols-2"
      >
        {providers.map((p) => (
          <label
            key={p.id}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${
              p.id === chosen ? 'border-primary bg-primary-tint' : 'border-line bg-raised'
            }`}
          >
            <input
              type="radio"
              name={group}
              className="mt-1"
              checked={p.id === chosen}
              onChange={() => {
                pick(p);
              }}
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                {p.name}
                {p.id === current && <Badge tone="accent">{t('model.current')}</Badge>}
              </span>
              <span className="text-sm text-ink-secondary">{p.description[lang]}</span>
            </span>
          </label>
        ))}
      </div>

      {provider && (
        <>
          {provider.fields.map((f) => (
            <div key={f.key}>
              {renderField(f, config[f.key] ?? '', (v) => {
                setConfig((c) => ({ ...c, [f.key]: v }));
                setCheck(null);
              })}
            </div>
          ))}
          {key && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={secretId} className="font-medium">
                {key.description[lang]} <Ltr>{key.envVar}</Ltr>
              </label>
              <input
                id={secretId}
                type="password"
                autoComplete="off"
                dir="ltr"
                className={`${input} max-w-md`}
                value={secret}
                disabled={!provider.writable}
                placeholder={key.set ? t('provider.keySet') : ''}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setCheck(null);
                }}
              />
              <span className="text-xs text-ink-secondary">
                {key.set ? t('provider.keySetHint') : key.howToCreate[lang]}
              </span>
              {!provider.writable && !key.set && (
                <span className="text-sm text-bad-text">{t('provider.notWritable')}</span>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondary}
              disabled={busy || needsKey}
              onClick={() => void runCheck()}
            >
              {t('provider.check', { provider: provider.name })}
            </button>
            <button type="button" className={secondary} onClick={onCancel}>
              {t('provider.cancel')}
            </button>
          </div>
          {problem && (
            <p role="alert" className="text-sm text-bad-text">
              {t('provider.failed', { error: problem })}
            </p>
          )}
          {check && (
            <>
              <ul className="flex flex-col gap-1 text-sm" aria-label={t('provider.checks')}>
                {check.checks.map((c) => (
                  <li key={c.check}>
                    <Badge tone={c.status === 'pass' ? 'ok' : 'bad'}>{c.status}</Badge> {c.message}
                  </li>
                ))}
              </ul>
              <div
                role="radiogroup"
                aria-label={t('provider.model')}
                className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised"
              >
                {check.models.options.map((o) => (
                  <label
                    key={o.name}
                    className={`flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 ${o.name === model ? 'bg-primary-tint' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`${group}-model`}
                        aria-label={o.name}
                        checked={o.name === model}
                        onChange={() => {
                          setModel(o.name);
                        }}
                      />
                      <Ltr>{o.name}</Ltr>
                      {o.available === false && <Badge tone="plain">{t('model.notListed')}</Badge>}
                    </span>
                    <span className="flex flex-wrap gap-3 text-sm text-ink-secondary">
                      {o.price && (
                        <span>
                          {t('model.price', {
                            input: money(o.price.inputPerMTok),
                            output: money(o.price.outputPerMTok),
                          })}
                        </span>
                      )}
                      {o.monthCost !== null && (
                        <span className="font-medium text-ink">
                          {t('model.monthOnThis', { cost: money(o.monthCost) })}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <div role="note" className="rounded-lg border border-line bg-raised p-3 text-sm">
                <p className="font-semibold">
                  {t('provider.warnTitle', { provider: provider.name })}
                </p>
                {provider.sends.map((s) => (
                  <p key={s.en} className="mt-1 text-ink-secondary">
                    {s[lang]}
                  </p>
                ))}
              </div>
              <div>
                <button
                  type="button"
                  className={primary}
                  disabled={busy || model === ''}
                  onClick={() => {
                    const action = post('settings/provider-switch', { ...candidate(), base });
                    setSecret('');
                    onSwitch(action);
                  }}
                >
                  {t('provider.switch', { provider: provider.name, model })}
                </button>
                <p className="mt-2 text-sm text-ink-secondary">{t('provider.switchNote')}</p>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
