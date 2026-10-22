import { useCallback, useId, useState } from 'react';
import { get, post, type ContextWarning, type ModelOptionsView } from './api.ts';
import { useI18n } from './i18n.tsx';
import { useLoad } from './load.ts';
import { Badge, ContextNote, Mono } from './ui.tsx';

const input =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 disabled:opacity-60';
const secondary =
  'inline-flex h-9 items-center rounded-lg border border-line-strong bg-raised px-3 text-sm font-medium hover:bg-muted disabled:opacity-50';

type TestState =
  | { name: string; state: 'running' }
  | { name: string; state: 'ok'; warning?: ContextWarning }
  | {
      name: string;
      state: 'failed';
      error: string;
    };

/**
 * The model, from the models the agent's key can use, with list prices and what this
 * month's usage would have cost on each. Saving tries the new model first (the agent refuses
 * one that does not answer); Test does the same call ahead of time.
 */
export function ModelPicker({
  provider,
  current,
  value,
  canEdit,
  onSignedOut,
  onChange,
}: {
  provider: string;
  current: string;
  value: string;
  canEdit: boolean;
  onSignedOut: () => void;
  onChange: (name: string) => void;
}) {
  const { t, num } = useI18n();
  const group = useId();
  const otherId = useId();
  const load = useCallback(() => get<ModelOptionsView>('settings/models'), []);
  const { data, error } = useLoad(load, onSignedOut);
  const [other, setOther] = useState(false);
  const [test, setTest] = useState<TestState | null>(null);
  const money = (n: number) => num(n, { style: 'currency', currency: 'USD' });

  const runTest = async (name: string) => {
    setTest({ name, state: 'running' });
    const result = await post<{ ok: boolean; error?: string; contextWarning?: ContextWarning }>(
      'settings/model-test',
      { name },
    ).catch((e: unknown): { ok: boolean; error?: string; contextWarning?: ContextWarning } => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    setTest(
      result.ok
        ? {
            name,
            state: 'ok',
            ...(result.contextWarning ? { warning: result.contextWarning } : {}),
          }
        : { name, state: 'failed', error: result.error ?? t('model.testFailed') },
    );
  };

  // Without the list (read-only, or it failed to load), the name is a plain field.
  if (!canEdit || error || !data) {
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={otherId} className="font-medium">
          {t('settings.limits.modelName', { provider })}
        </label>
        <input
          id={otherId}
          className={`${input} max-w-sm`}
          value={value}
          disabled={!canEdit}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        {canEdit && !data && !error && (
          <p className="text-sm text-ink-secondary">{t('app.loading')}</p>
        )}
      </div>
    );
  }

  const listed = data.options.some((o) => o.name === value);
  const showOther = other || !listed;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-secondary">
        {t('model.intro', { provider })}
        {data.listError && <> {t('model.listError', { error: data.listError })}</>}
      </p>
      <div
        role="radiogroup"
        aria-label={t('model.choose')}
        className="flex flex-col divide-y divide-line rounded-lg border border-line"
      >
        {data.options.map((o) => {
          const id = `${group}-${o.name}`;
          const checked = !showOther && o.name === value;
          return (
            <label
              key={o.name}
              htmlFor={id}
              className={`flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2.5 ${checked ? 'bg-primary-tint' : ''}`}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <input
                  id={id}
                  type="radio"
                  name={group}
                  checked={checked}
                  onChange={() => {
                    setOther(false);
                    onChange(o.name);
                  }}
                />
                <Mono>{o.name}</Mono>
                {o.name === current && <Badge tone="accent">{t('model.current')}</Badge>}
                {o.available === false && <Badge tone="plain">{t('model.notListed')}</Badge>}
              </span>
              <span className="flex flex-wrap items-center gap-3 text-sm text-ink-secondary">
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
                    {t(o.name === current ? 'model.monthSoFar' : 'model.monthOnThis', {
                      cost: money(o.monthCost),
                    })}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        <div className={`flex flex-col gap-2 px-3 py-2.5 ${showOther ? 'bg-primary-tint' : ''}`}>
          <label htmlFor={`${group}-other`} className="flex cursor-pointer items-center gap-2">
            <input
              id={`${group}-other`}
              type="radio"
              name={group}
              checked={showOther}
              onChange={() => {
                setOther(true);
              }}
            />
            {t('model.other')}
          </label>
          {showOther && (
            <input
              aria-label={t('model.otherName')}
              className={`${input} max-w-sm`}
              value={value}
              onChange={(e) => {
                onChange(e.target.value.trim());
              }}
            />
          )}
        </div>
      </div>
      {value !== current && value !== '' && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={secondary}
            disabled={test?.state === 'running'}
            onClick={() => void runTest(value)}
          >
            {t('model.test', { name: value })}
          </button>
          <span role="status" className="text-sm">
            {test?.name === value && test.state === 'running' && t('model.testing')}
            {test?.name === value && test.state === 'ok' && (
              <span className="font-semibold text-ok-text">{t('model.testOk')}</span>
            )}
            {test?.name === value && test.state === 'failed' && (
              <span className="text-bad-text">{t('model.testError', { error: test.error })}</span>
            )}
          </span>
        </div>
      )}
      {test?.name === value && test.state === 'ok' && test.warning && (
        <ContextNote warning={test.warning} />
      )}
      {value !== current && <p className="text-sm text-ink-secondary">{t('model.saveNote')}</p>}
    </div>
  );
}
