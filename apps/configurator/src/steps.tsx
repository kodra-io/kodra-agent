import { connectors, getModelProvider, modelProviders } from '@kodra-agent/connectors';
import {
  isSecretRequired,
  type Category,
  type ConfigField,
  type Manifest,
  type ModelProvider,
  type SecretSpec,
} from '@kodra-agent/schema';
import {
  includedSecrets,
  quickstartCommands,
  type AgentDraft,
  type DestructivePolicy,
  type DraftIssue,
  type StepId,
} from '@kodra-agent/templates';
import type { Dispatch } from 'react';
import { useI18n, type MessageKey } from './i18n.tsx';
import type { Action } from './state.ts';
import { Badge, CopyButton, RadioCards, Section, Switch, TextField, useIssueText } from './ui.tsx';

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
  const { lt } = useI18n();
  const { field } = props;
  const example =
    'example' in field && field.example !== undefined
      ? Array.isArray(field.example)
        ? field.example.join(', ')
        : field.example
      : undefined;
  return (
    <TextField
      label={lt(field.description)}
      value={props.value}
      fieldId={props.fieldId}
      placeholder={example}
      required={field.required && !('default' in field && field.default !== undefined)}
      inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'url' ? 'url' : 'text'}
      ltr
      error={props.error}
      onChange={props.onChange}
      onBlur={props.onBlur}
    />
  );
}

function SecretNames({ secrets, access }: { secrets: SecretSpec[]; access?: string | undefined }) {
  const { t, lt } = useI18n();
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
              <code dir="ltr" className="rounded bg-primary-tint px-1.5 py-0.5 font-mono">
                {secret.envVar}
              </code>
            ) : (
              <span className="font-medium">{t('connectors.fileSecret')}</span>
            )}{' '}
            <span className="text-ink-secondary">{lt(secret.description)}</span>
            {scopes.length > 0 ? (
              <span dir="auto" className="block text-ink-secondary">
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
        ltr
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
  const { t, lt } = useI18n();
  const provider = getModelProvider(draft.model.provider);
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
          description: lt(p.description),
        }))}
      />
      <TextField
        label={t('model.name')}
        hint={t('model.nameHint')}
        value={draft.model.name}
        fieldId="model.name"
        required
        ltr
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
          <p key={line.en} className="text-sm text-ink-secondary">
            {lt(line)}
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
  'chat',
];

function ConnectorCard({
  manifest,
  draft,
  dispatch,
  errorFor,
  touch,
}: StepProps & { manifest: Manifest }) {
  const { t, lt } = useI18n();
  const entry = draft.connectors[manifest.id];
  const enabled = entry?.enabled === true;
  const comingSoon = manifest.status === 'coming-soon';
  const access = manifest.accessLevels.length > 0 ? (entry?.access ?? 'read-only') : undefined;
  const summary = [
    ...(manifest.permissionsSummary.always ?? []),
    ...((access && manifest.permissionsSummary[access]) ?? []),
  ];
  const headingId = `connector-${manifest.id}`;
  const cardError = errorFor(`connector.${manifest.id}`);

  return (
    <article
      aria-labelledby={headingId}
      data-connector={manifest.id}
      className={`flex flex-col gap-4 rounded-lg border p-4 ${
        enabled ? 'border-primary bg-white' : 'border-line bg-white'
      } ${comingSoon ? 'border-dashed bg-surface' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h4 id={headingId} className="font-bold">
            {manifest.displayName}
            {comingSoon ? <Badge>{t('connectors.comingSoon')}</Badge> : null}
          </h4>
          <p className="text-sm text-ink-secondary">{lt(manifest.description)}</p>
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
          className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800"
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
                  <li key={line.en}>{lt(line)}</li>
                ))}
              </ul>
            </Section>
            <Section title={t('connectors.needs')}>
              {manifest.secrets.length === 0 ? (
                <p className="text-sm text-ink-secondary">{t('connectors.noSecrets')}</p>
              ) : (
                <>
                  <SecretNames
                    secrets={manifest.secrets.filter((s) => isSecretRequired(s, draft.target))}
                    access={access}
                  />
                  {manifest.secrets
                    .filter((s) => !isSecretRequired(s, draft.target))
                    .map((secret) => (
                      <label key={secret.key} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          checked={entry.optionalSecrets.includes(secret.key)}
                          onChange={(e) => {
                            dispatch({
                              type: 'optionalSecret',
                              id: manifest.id,
                              key: secret.key,
                              included: e.target.checked,
                            });
                          }}
                        />
                        <span>
                          {t('connectors.include', {
                            name:
                              secret.defaultRef === 'env'
                                ? secret.envVar
                                : t('connectors.fileSecret'),
                          })}{' '}
                          ({t('connectors.optional')}):{' '}
                          <span className="text-ink-secondary">{lt(secret.description)}</span>
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

export function ConnectorsStep(props: StepProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-8">
      <p className="text-ink-secondary">{t('connectors.intro')}</p>
      {CATEGORY_ORDER.map((category) => {
        const items = connectors.filter((c) => c.category === category);
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
    </div>
  );
}

const STEP_LABELS: Record<StepId | 'download', MessageKey> = {
  start: 'steps.start',
  model: 'steps.model',
  connectors: 'steps.connectors',
  review: 'steps.review',
  download: 'steps.download',
};

export function ReviewStep(
  props: StepProps & { issues: DraftIssue[]; goTo: (step: StepId) => void },
) {
  const { draft, dispatch, errorFor, touch, issues, goTo } = props;
  const { t, lt } = useI18n();
  const issueText = useIssueText();
  const provider = getModelProvider(draft.model.provider);
  const enabled = connectors.filter((c) => draft.connectors[c.id]?.enabled === true);
  const secrets = [
    ...(provider?.secrets ?? []).map((s) => ({ owner: provider?.displayName ?? '', s })),
    ...enabled.flatMap((m) =>
      includedSecrets(m, draft.connectors[m.id]?.optionalSecrets ?? [], draft.target).map((s) => ({
        owner: m.displayName,
        s,
      })),
    ),
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
                  <li key={line.en}>{lt(line)}</li>
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
                    <li key={line.en}>{lt(line)}</li>
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
                  <code dir="ltr" className="rounded bg-primary-tint px-1.5 py-0.5 font-mono">
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
          placeholder="@omar"
          required
          ltr
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
          ltr
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

      <Section title={issues.length > 0 ? t('review.problems') : t('review.noProblems')}>
        {issues.length > 0 ? (
          <ul data-testid="problems" className="flex flex-col gap-2">
            {issues.map((issue, i) => (
              <li
                key={`${issue.field}-${issue.code}-${String(i)}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800"
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
          className="self-start rounded-md bg-primary px-5 py-3 font-bold text-white hover:bg-primary-deep disabled:cursor-not-allowed disabled:bg-ink-secondary"
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
                dir="ltr"
                tabIndex={0}
                className="min-w-0 flex-1 overflow-x-auto rounded-md bg-ink px-3 py-2 font-mono text-sm whitespace-pre text-white"
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
