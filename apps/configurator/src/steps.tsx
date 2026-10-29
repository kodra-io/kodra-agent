import { connectors, getModelProvider, modelProviders } from '@kodra-agent/connectors';
import {
  ENTRY_NAME,
  entryEnvVar,
  isSecretRequired,
  type Category,
  type ConfigField,
  type EntriesField,
  type EntryField,
  type Manifest,
  type ModelProvider,
  type SecretSpec,
} from '@kodra-agent/schema';
import {
  entrySecrets,
  includedSecrets,
  digestDestination,
  quickstartCommands,
  type AgentDraft,
  type DestructivePolicy,
  type DraftIssue,
  type EntryDraft,
  type StepId,
} from '@kodra-agent/templates';
import { useState, type Dispatch } from 'react';
import { useI18n, type MessageKey } from './i18n.tsx';
import { ApprovalRulesSummary } from './policy-steps.tsx';
import type { Action } from './state.ts';
import {
  Badge,
  CopyButton,
  RadioCards,
  Section,
  SelectField,
  Switch,
  TextField,
  useIssueText,
} from './ui.tsx';

export interface StepProps {
  draft: AgentDraft;
  dispatch: Dispatch<Action>;
  /** The visible error for a field, if any. */
  errorFor: (field: string) => string | undefined;
  touch: (field: string) => void;
}

function ConfigFieldInput(props: {
  field: ConfigField;
  value: string;
  fieldId: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const { field } = props;
  const example =
    'example' in field && field.example !== undefined
      ? Array.isArray(field.example)
        ? field.example.join(', ')
        : field.example
      : undefined;
  return (
    <TextField
      label={field.description}
      value={props.value}
      fieldId={props.fieldId}
      placeholder={example}
      required={field.required && !('default' in field && field.default !== undefined)}
      inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'url' ? 'url' : 'text'}
      error={props.error}
      onChange={props.onChange}
      onBlur={props.onBlur}
    />
  );
}

function SecretNames({ secrets, access }: { secrets: SecretSpec[]; access?: string | undefined }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-2">
      {secrets.map((secret) => {
        const scopes = [
          ...(secret.minimumScopes.always ?? []),
          ...((access === 'read-only' || access === 'read-write-approved'
            ? secret.minimumScopes[access]
            : undefined) ?? []),
        ];
        return (
          <li key={secret.key} className="text-sm">
            {secret.defaultRef === 'env' ? (
              <code className="rounded bg-primary-tint px-1.5 py-0.5 font-mono">
                {secret.envVar}
              </code>
            ) : (
              <span className="font-medium">{t('connectors.fileSecret')}</span>
            )}{' '}
            <span className="text-ink-secondary">{secret.description}</span>
            {scopes.length > 0 ? (
              <span className="block text-ink-secondary">
                {t('connectors.scopes', { scopes: scopes.join('; ') })}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function StartStep({ draft, dispatch, errorFor, touch }: StepProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <TextField
        label={t('start.name')}
        hint={t('start.nameHint')}
        value={draft.name}
        fieldId="name"
        placeholder="payments-team-agent"
        required
        error={errorFor('name')}
        onChange={(value) => {
          dispatch({ type: 'name', value });
        }}
        onBlur={() => {
          touch('name');
        }}
      />
      <RadioCards
        legend={t('start.target')}
        name="target"
        value={draft.target}
        onChange={(value) => {
          dispatch({ type: 'target', value });
        }}
        options={[
          { value: 'compose', label: t('target.compose'), description: t('target.composeDesc') },
          {
            value: 'kubernetes',
            label: t('target.kubernetes'),
            description: t('target.kubernetesDesc'),
          },
        ]}
      />
    </div>
  );
}

export function ModelStep({ draft, dispatch, errorFor, touch }: StepProps) {
  const { t } = useI18n();
  const provider = getModelProvider(draft.model.provider);
  const suggestions = Object.keys(provider?.pricing?.models ?? {});
  return (
    <div className="flex flex-col gap-6">
      <RadioCards<ModelProvider>
        legend={t('model.provider')}
        name="provider"
        value={draft.model.provider}
        columns="sm:grid-cols-2 xl:grid-cols-3"
        onChange={(value) => {
          dispatch({ type: 'provider', value });
        }}
        options={modelProviders.map((p) => ({
          value: p.id as ModelProvider,
          label: p.displayName,
          description: p.description,
        }))}
      />
      <TextField
        label={t('model.name')}
        hint={t(suggestions.length > 0 ? 'model.nameHintSuggested' : 'model.nameHint')}
        value={draft.model.name}
        fieldId="model.name"
        suggestions={suggestions}
        placeholder={suggestions[0]}
        required
        error={errorFor('model.name')}
        onChange={(value) => {
          dispatch({ type: 'modelName', value });
        }}
        onBlur={() => {
          touch('model.name');
        }}
      />
      {provider?.configFields.map((field) => (
        <ConfigFieldInput
          key={`${provider.id}-${field.key}`}
          field={field}
          fieldId={`model.${field.key}`}
          value={draft.model.fields[field.key] ?? ''}
          error={errorFor(`model.${field.key}`)}
          onChange={(value) => {
            dispatch({ type: 'modelField', key: field.key, value });
          }}
          onBlur={() => {
            touch(`model.${field.key}`);
          }}
        />
      ))}
      <Section title={t('model.asks')}>
        {provider && provider.secrets.length > 0 ? (
          <SecretNames secrets={provider.secrets} />
        ) : (
          <p className="text-sm text-ink-secondary">{t('model.noKey')}</p>
        )}
        {provider?.permissionsSummary.always?.map((line) => (
          <p key={line} className="text-sm text-ink-secondary">
            {line}
          </p>
        ))}
      </Section>
    </div>
  );
}

const CATEGORY_ORDER: readonly Category[] = [
  'source',
  'build',
  'deploy',
  'cicd',
  'monitoring',
  'cloud',
  'database',
  'chat',
];

/** Optional secrets as choices: one per secret, or one per group of secrets that go together. */
function optionalChoices(
  secrets: SecretSpec[],
  fileLabel: string,
): { key: string; label: string; description: string; secrets: SecretSpec[] }[] {
  const choices: { key: string; label: string; description: string; secrets: SecretSpec[] }[] = [];
  for (const secret of secrets) {
    const group = secret.group;
    const same = group ? choices.find((c) => c.key === `group:${group.key}`) : undefined;
    if (same) same.secrets.push(secret);
    else if (group)
      choices.push({
        key: `group:${group.key}`,
        label: group.label,
        description: group.description,
        secrets: [secret],
      });
    else
      choices.push({
        key: secret.key,
        label: secret.defaultRef === 'env' ? secret.envVar : fileLabel,
        description: secret.description,
        secrets: [secret],
      });
  }
  return choices;
}

function ConnectorCard({
  manifest,
  draft,
  dispatch,
  errorFor,
  touch,
}: StepProps & { manifest: Manifest }) {
  const { t } = useI18n();
  const entry = draft.connectors[manifest.id];
  const enabled = entry?.enabled === true;
  const comingSoon = manifest.status === 'coming-soon';
  const access = manifest.accessLevels.length > 0 ? (entry?.access ?? 'read-only') : undefined;
  const summary = [
    ...(manifest.permissionsSummary.always ?? []),
    ...((access && manifest.permissionsSummary[access]) ?? []),
  ];
  const headingId = `connector-${manifest.id}`;
  // Entries (databases) name their own secrets, one set per entry.
  const entriesField = manifest.configFields.find((f): f is EntriesField => f.kind === 'entries');
  const named = entrySecrets(manifest, entry);
  const cardError = errorFor(`connector.${manifest.id}`);

  return (
    <article
      aria-labelledby={headingId}
      data-connector={manifest.id}
      className={`flex flex-col gap-4 rounded-xl border p-4 ${
        enabled ? 'border-primary bg-white' : 'border-line bg-white'
      } ${comingSoon ? 'border-dashed bg-surface' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h4 id={headingId} className="font-bold">
            {manifest.displayName} {comingSoon ? <Badge>{t('connectors.comingSoon')}</Badge> : null}
            {manifest.status === 'preview' ? <Badge>{t('connectors.preview')}</Badge> : null}
          </h4>
          <p className="text-sm text-ink-secondary">{manifest.description}</p>
        </div>
        <Switch
          checked={enabled}
          disabled={comingSoon}
          label={t('connectors.enable', { name: manifest.displayName })}
          onChange={(checked) => {
            dispatch({ type: 'toggle', id: manifest.id, enabled: checked });
          }}
        />
      </div>

      {cardError ? (
        <p
          role="alert"
          className="rounded-lg border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {cardError}
        </p>
      ) : null}

      {entry?.enabled === true ? (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          {manifest.accessLevels.length > 1 ? (
            <RadioCards
              legend={t('connectors.access')}
              name={`access-${manifest.id}`}
              value={entry.access}
              onChange={(value) => {
                dispatch({ type: 'access', id: manifest.id, value });
              }}
              options={manifest.accessLevels.map((level) => ({
                value: level,
                label: t(`access.${level}` as MessageKey),
              }))}
            />
          ) : null}

          {manifest.configFields.map((field) => {
            const fieldId = `connector.${manifest.id}.${field.key}`;
            if (field.kind === 'entries') {
              return (
                <EntriesEditor
                  key={field.key}
                  connectorId={manifest.id}
                  field={field}
                  entries={entry.entries?.[field.key] ?? []}
                  dispatch={dispatch}
                  errorFor={errorFor}
                  touch={touch}
                />
              );
            }
            return (
              <ConfigFieldInput
                key={field.key}
                field={field}
                fieldId={fieldId}
                value={entry.config[field.key] ?? ''}
                error={errorFor(fieldId)}
                onChange={(value) => {
                  dispatch({ type: 'connectorField', id: manifest.id, key: field.key, value });
                }}
                onBlur={() => {
                  touch(fieldId);
                }}
              />
            );
          })}

          <div className="grid gap-4 md:grid-cols-2">
            <Section title={t('connectors.canDo')}>
              <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
                {summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Section>
            <Section title={t('connectors.needs')}>
              {entriesField ? (
                named.length > 0 ? (
                  <SecretNames secrets={named} />
                ) : (
                  <p className="text-sm text-ink-secondary">
                    {t('connectors.entrySecrets', { noun: entriesField.noun })}
                  </p>
                )
              ) : null}
              {manifest.secrets.length === 0 ? (
                entriesField ? null : (
                  <p className="text-sm text-ink-secondary">{t('connectors.noSecrets')}</p>
                )
              ) : (
                <>
                  <SecretNames
                    secrets={manifest.secrets.filter((s) => isSecretRequired(s, draft.target))}
                    access={access}
                  />
                  {optionalChoices(
                    manifest.secrets.filter((s) => !isSecretRequired(s, draft.target)),
                    t('connectors.fileSecret'),
                  ).map((choice) => (
                    <label key={choice.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-primary"
                        checked={choice.secrets.every((s) => entry.optionalSecrets.includes(s.key))}
                        onChange={(e) => {
                          for (const s of choice.secrets) {
                            dispatch({
                              type: 'optionalSecret',
                              id: manifest.id,
                              key: s.key,
                              included: e.target.checked,
                            });
                          }
                        }}
                      />
                      <span>
                        {t('connectors.include', { name: choice.label })} (
                        {t('connectors.optional')}):{' '}
                        <span className="text-ink-secondary">{choice.description}</span>
                      </span>
                    </label>
                  ))}
                </>
              )}
            </Section>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * An `entries` setting (databases): add, name, and fill in each entry. Secrets are never
 * typed here: each shows the variable it will come from, which init asks for.
 */
function EntriesEditor(props: {
  connectorId: string;
  field: EntriesField;
  entries: readonly EntryDraft[];
  dispatch: StepProps['dispatch'];
  errorFor: StepProps['errorFor'];
  touch: StepProps['touch'];
}) {
  const { t } = useI18n();
  const { connectorId: id, field, entries, dispatch } = props;
  const prefix = `connector.${id}.${field.key}`;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-medium">{field.description}</legend>
      <p className="text-sm text-ink-secondary">
        {entries.length === 0 ? t('entries.none') : t('entries.secretsNote')}
      </p>
      {entries.map((entry, i) => (
        <EntryCard
          // Entries have no id until named; their place in the list is stable while editing.
          key={i}
          index={i}
          field={field}
          entry={entry}
          fieldId={(key) => `${prefix}.${String(i)}.${key}`}
          errorFor={props.errorFor}
          touch={props.touch}
          onSet={(key, value) => {
            dispatch({ type: 'entryField', id, key: field.key, index: i, field: key, value });
          }}
          onRemove={() => {
            dispatch({ type: 'entryRemove', id, key: field.key, index: i });
          }}
        />
      ))}
      {entries.length < field.max ? (
        <button
          type="button"
          className="self-start rounded-lg border border-line px-3 py-2 text-sm hover:bg-primary-tint"
          onClick={() => {
            dispatch({ type: 'entryAdd', id, key: field.key });
          }}
        >
          {t('entries.add', { noun: field.noun })}
        </button>
      ) : null}
    </fieldset>
  );
}

function EntryCard(props: {
  index: number;
  field: EntriesField;
  entry: EntryDraft;
  fieldId: (key: string) => string;
  errorFor: StepProps['errorFor'];
  touch: StepProps['touch'];
  onSet: (key: string, value: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { field, entry } = props;
  const name = (entry['name'] ?? '').trim();
  // Up front: what every entry needs, and its own secret (a password). The rest, like a
  // tunnel, under More settings.
  const first = (f: EntryField) =>
    ('required' in f && f.required) || (f.kind === 'secret' && f.requiredWith === undefined);
  const main = field.fields.filter(first);
  const more = field.fields.filter((f) => !first(f));
  const render = (f: EntryField) => {
    const fieldId = props.fieldId(f.key);
    if (f.kind === 'secret') {
      return (
        <div key={f.key} className="flex flex-col gap-1">
          <span className="font-medium">{f.description}</span>
          <span className="text-sm text-ink-secondary">
            {ENTRY_NAME.test(name) ? (
              <>
                {t('entries.secret')}{' '}
                <code className="rounded bg-primary-tint px-1.5 py-0.5 font-mono">
                  {entryEnvVar(field, name, f.envVar)}
                </code>
              </>
            ) : (
              t('entries.secretNoName')
            )}
          </span>
        </div>
      );
    }
    if (f.kind === 'choice') {
      return (
        <SelectField
          key={f.key}
          label={f.description}
          value={entry[f.key] ?? f.default ?? ''}
          options={f.options}
          allowEmpty={!f.required && f.default === undefined}
          required={f.required}
          fieldId={fieldId}
          error={props.errorFor(fieldId)}
          onChange={(value) => {
            props.onSet(f.key, value);
          }}
        />
      );
    }
    if (f.kind === 'boolean') {
      return (
        <label key={f.key} className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            className="accent-primary"
            checked={(entry[f.key] ?? String(f.default)) === 'true'}
            onChange={(e) => {
              props.onSet(f.key, String(e.target.checked));
            }}
          />
          {f.description}
        </label>
      );
    }
    const placeholder =
      f.kind === 'integer' ? (f.default !== undefined ? String(f.default) : undefined) : f.example;
    return (
      <TextField
        key={f.key}
        label={f.description}
        value={entry[f.key] ?? ''}
        fieldId={fieldId}
        placeholder={placeholder}
        required={f.required && !('default' in f && f.default !== undefined)}
        inputMode={f.kind === 'integer' ? 'numeric' : 'text'}
        error={props.errorFor(fieldId)}
        onChange={(value) => {
          props.onSet(f.key, value);
        }}
        onBlur={() => {
          props.touch(fieldId);
        }}
      />
    );
  };
  const nameId = props.fieldId('name');
  return (
    <div
      data-entry={props.index}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-48 flex-1">
          <TextField
            label={t('entries.name')}
            hint={t('entries.nameHint')}
            value={entry['name'] ?? ''}
            fieldId={nameId}
            placeholder="orders"
            required
            error={props.errorFor(nameId)}
            onChange={(value) => {
              props.onSet('name', value.toLowerCase());
            }}
            onBlur={() => {
              props.touch(nameId);
            }}
          />
        </div>
        <button
          type="button"
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm hover:bg-primary-tint"
          onClick={props.onRemove}
        >
          {t('entries.remove', { name: name || t('entries.new') })}
        </button>
      </div>
      {main.map(render)}
      {more.length > 0 ? (
        <details
          className="rounded-xl border border-line bg-white p-3"
          open={more.some((f) => f.kind !== 'secret' && (entry[f.key] ?? '') !== '')}
        >
          <summary className="cursor-pointer font-medium">{t('entries.more')}</summary>
          <div className="mt-3 flex flex-col gap-4">{more.map(render)}</div>
        </details>
      ) : null}
    </div>
  );
}

const stable = connectors.filter((c) => c.status !== 'preview');
const preview = connectors.filter((c) => c.status === 'preview');

export function ConnectorsStep(props: StepProps) {
  const { t } = useI18n();
  // Preview connectors stay folded away unless the draft (a shared link) already uses one.
  const [moreOpen, setMoreOpen] = useState(() =>
    preview.some((c) => props.draft.connectors[c.id]?.enabled === true),
  );
  return (
    <div className="flex flex-col gap-8">
      <p className="text-ink-secondary">{t('connectors.intro')}</p>
      {CATEGORY_ORDER.map((category) => {
        const items = stable.filter((c) => c.category === category);
        if (items.length === 0) return null;
        return (
          <section key={category} className="flex flex-col gap-3">
            <h3 className="text-lg font-bold">{t(`category.${category}` as MessageKey)}</h3>
            <div className="flex flex-col gap-3">
              {items.map((manifest) => (
                <ConnectorCard key={manifest.id} manifest={manifest} {...props} />
              ))}
            </div>
          </section>
        );
      })}
      {preview.length > 0 ? (
        <details
          data-testid="more-connectors"
          className="rounded-xl border border-line bg-white p-4"
          open={moreOpen}
          onToggle={(e) => {
            setMoreOpen(e.currentTarget.open);
          }}
        >
          <summary className="cursor-pointer text-lg font-bold">{t('connectors.more')}</summary>
          <p className="mt-2 text-sm text-ink-secondary">{t('connectors.moreIntro')}</p>
          {moreOpen ? (
            <div className="mt-4 flex flex-col gap-3">
              {preview.map((manifest) => (
                <ConnectorCard key={manifest.id} manifest={manifest} {...props} />
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

const STEP_LABELS: Record<StepId | 'download', MessageKey> = {
  profile: 'steps.profile',
  start: 'steps.start',
  model: 'steps.model',
  connectors: 'steps.connectors',
  environments: 'steps.environments',
  review: 'steps.review',
  download: 'steps.download',
};

export function ReviewStep(
  props: StepProps & {
    issues: DraftIssue[];
    goTo: (step: StepId) => void;
    onAddEnvironments: () => void;
  },
) {
  const { draft, dispatch, errorFor, touch, issues, goTo } = props;
  const { t } = useI18n();
  const issueText = useIssueText();
  const provider = getModelProvider(draft.model.provider);
  const enabled = connectors.filter((c) => draft.connectors[c.id]?.enabled === true);
  const secrets = [
    ...(provider?.secrets ?? []).map((s) => ({ owner: provider?.displayName ?? '', s })),
    ...enabled.flatMap((m) => [
      ...includedSecrets(m, draft.connectors[m.id]?.optionalSecrets ?? [], draft.target).map(
        (s) => ({ owner: m.displayName, s }),
      ),
      ...entrySecrets(m, draft.connectors[m.id]).map((s) => ({
        owner: `${m.displayName} (${s.key.slice(0, s.key.indexOf('.'))})`,
        s,
      })),
    ]),
  ];

  return (
    <div className="flex flex-col gap-8">
      <Section title={t('review.permissions')}>
        <ul className="flex flex-col gap-3">
          {provider ? (
            <li>
              <p className="font-medium">
                {t('review.model')}: {provider.displayName}
              </p>
              <ul className="list-disc ps-5 text-sm">
                {(provider.permissionsSummary.always ?? []).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ) : null}
          {enabled.map((m) => {
            const access = m.accessLevels.length > 0 ? draft.connectors[m.id]?.access : undefined;
            const lines = [
              ...(m.permissionsSummary.always ?? []),
              ...((access && m.permissionsSummary[access]) ?? []),
            ];
            return (
              <li key={m.id}>
                <p className="font-medium">
                  {m.displayName}
                  {access ? <Badge>{t(`access.${access}` as MessageKey)}</Badge> : null}
                </p>
                <ul className="list-disc ps-5 text-sm">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t('review.secrets')}>
        <p className="text-sm text-ink-secondary">{t('review.secretsNote')}</p>
        {secrets.length === 0 ? (
          <p className="text-sm">{t('review.noSecrets')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {secrets.map(({ owner, s }) => (
              <li key={`${owner}-${s.key}`}>
                <span className="font-medium">{owner}:</span>{' '}
                {s.defaultRef === 'env' ? (
                  <code className="rounded bg-primary-tint px-1.5 py-0.5 font-mono">
                    {s.envVar}
                  </code>
                ) : (
                  t('connectors.fileSecret')
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('review.policy')}>
        <TextField
          label={t('review.approvers')}
          hint={t('review.approversHint')}
          value={draft.policy.approvers}
          fieldId="policy.approvers"
          placeholder="U0123ABCD, console:omar"
          required
          error={errorFor('policy.approvers')}
          onChange={(value) => {
            dispatch({ type: 'approvers', value });
          }}
          onBlur={() => {
            touch('policy.approvers');
          }}
        />
        <TextField
          label={t('review.expires')}
          value={draft.policy.expiresAfterMinutes}
          fieldId="policy.expiresAfterMinutes"
          inputMode="numeric"
          required
          error={errorFor('policy.expiresAfterMinutes')}
          onChange={(value) => {
            dispatch({ type: 'expires', value });
          }}
          onBlur={() => {
            touch('policy.expiresAfterMinutes');
          }}
        />
        <RadioCards<DestructivePolicy>
          legend={t('review.destructive')}
          name="destructive"
          value={draft.policy.destructiveActions}
          onChange={(value) => {
            dispatch({ type: 'destructive', value });
          }}
          options={[
            { value: 'deny', label: t('destructive.deny') },
            { value: 'require-approval', label: t('destructive.require-approval') },
          ]}
        />
      </Section>

      <ApprovalRulesSummary draft={draft} onAddEnvironments={props.onAddEnvironments} />

      <Section title={t('review.console')}>
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-ink-secondary">
            {t(draft.target === 'compose' ? 'review.consoleCompose' : 'review.consoleKubernetes')}
          </p>
          <Switch
            checked={draft.console.enabled}
            label={t('review.consoleSwitch')}
            onChange={(enabled) => {
              dispatch({ type: 'console', enabled });
            }}
          />
        </div>
        {draft.console.enabled && (
          <div className="mt-4 flex items-start justify-between gap-4">
            <p className="text-sm text-ink-secondary">{t('review.consoleChat')}</p>
            <Switch
              checked={draft.console.chat}
              label={t('review.consoleChatSwitch')}
              onChange={(chat) => {
                dispatch({ type: 'consoleChat', chat });
              }}
            />
          </div>
        )}
      </Section>

      <Section title={t('review.checks')}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2 text-sm text-ink-secondary">
            <p>{t('review.checksText')}</p>
            {draft.checks.enabled && (
              <p
                data-testid="checks-where"
                className={digestDestination(draft) === 'log' ? 'text-warn-text' : undefined}
              >
                {t(`review.checksWhere.${digestDestination(draft)}`)}
              </p>
            )}
          </div>
          <Switch
            checked={draft.checks.enabled}
            label={t('review.checksSwitch')}
            onChange={(enabled) => {
              // Suggest the browser's own time zone the first time (read locally, never sent).
              const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              dispatch({
                type: 'checks',
                patch:
                  enabled && draft.checks.timezone === 'UTC' && zone
                    ? { enabled, timezone: zone }
                    : { enabled },
              });
            }}
          />
        </div>
        {draft.checks.enabled && (
          <div className="mt-4 flex flex-col gap-4">
            <TextField
              label={t('review.checksAt')}
              hint={t('review.checksAtHint')}
              value={draft.checks.at}
              fieldId="checks.at"
              inputMode="numeric"
              required
              error={errorFor('checks.at')}
              onChange={(at) => {
                dispatch({ type: 'checks', patch: { at } });
              }}
              onBlur={() => {
                touch('checks.at');
              }}
            />
            <RadioCards<'weekdays' | 'every-day'>
              legend={t('review.checksDays')}
              name="checks-days"
              value={draft.checks.days}
              onChange={(days) => {
                dispatch({ type: 'checks', patch: { days } });
              }}
              options={[
                { value: 'weekdays', label: t('review.checksWeekdays') },
                { value: 'every-day', label: t('review.checksEveryDay') },
              ]}
            />
            <TextField
              label={t('review.checksZone')}
              hint={t('review.checksZoneHint')}
              value={draft.checks.timezone}
              fieldId="checks.timezone"
              required
              error={errorFor('checks.timezone')}
              onChange={(timezone) => {
                dispatch({ type: 'checks', patch: { timezone } });
              }}
              onBlur={() => {
                touch('checks.timezone');
              }}
            />
          </div>
        )}
      </Section>

      <Section title={issues.length > 0 ? t('review.problems') : t('review.noProblems')}>
        {issues.length > 0 ? (
          <ul data-testid="problems" className="flex flex-col gap-2">
            {issues.map((issue, i) => (
              <li
                key={`${issue.field}-${issue.code}-${String(i)}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                <span>{issueText(issue)}</span>
                {issue.step !== 'review' ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      goTo(issue.step);
                    }}
                  >
                    {t('review.goTo', { step: t(STEP_LABELS[issue.step]) })}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

export function DownloadStep(props: {
  draft: AgentDraft;
  blocked: boolean;
  zipName: string;
  busy: boolean;
  onDownload: () => void;
}) {
  const { t } = useI18n();
  const commands = quickstartCommands(props.draft);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={props.blocked || props.busy}
          aria-describedby={props.blocked ? 'download-blocked' : undefined}
          onClick={props.onDownload}
          className="self-start rounded-lg bg-primary px-5 py-3 font-bold text-white hover:bg-primary-deep disabled:cursor-not-allowed disabled:bg-ink-secondary"
        >
          {props.busy ? t('download.working') : t('download.button', { file: props.zipName })}
        </button>
        {props.blocked ? (
          <p id="download-blocked" role="alert" className="text-sm text-red-800">
            {t('download.blocked')}
          </p>
        ) : null}
      </div>

      <Section title={t('download.quickstart')}>
        <ol className="flex flex-col gap-2">
          {commands.map((cmd) => (
            <li key={cmd} className="flex flex-wrap items-center gap-2">
              <code
                tabIndex={0}
                className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-ink px-3 py-2 font-mono text-sm whitespace-pre text-white"
              >
                {cmd}
              </code>
              <CopyButton text={cmd} />
            </li>
          ))}
        </ol>
      </Section>

      <Section title={t('download.share')}>
        <p className="text-sm text-ink-secondary">{t('download.shareHint')}</p>
        <div>
          <CopyButton text={() => window.location.href} label={t('download.copyLink')} />
        </div>
      </Section>
    </div>
  );
}
