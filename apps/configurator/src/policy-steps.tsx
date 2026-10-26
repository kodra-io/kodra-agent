import type { ApprovalRules, Profile } from '@kodra-agent/schema';
import { effectivePolicy, MAX_ENVIRONMENTS, type AgentDraft } from '@kodra-agent/templates';
import type { Dispatch } from 'react';
import { useI18n, type MessageKey } from './i18n.tsx';
import type { Action } from './state.ts';
import type { StepProps } from './steps.tsx';
import { RadioCards, Section, Switch, TextField } from './ui.tsx';

const PROFILES: readonly Profile[] = ['starter', 'team', 'strict'];

/** "Who is this agent for?": a profile sets defaults only (PLAN-v0.2 M10). */
export function ProfileStep({ draft, dispatch }: StepProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <RadioCards<Profile>
        legend={t('profile.legend')}
        name="profile"
        value={draft.profile}
        columns="md:grid-cols-3"
        onChange={(value) => {
          dispatch({ type: 'profile', value });
        }}
        options={PROFILES.map((p) => ({
          value: p,
          label: t(`profile.${p}` as MessageKey),
          description: t(`profile.${p}Desc` as MessageKey),
        }))}
      />
      <p className="text-sm text-ink-secondary">{t('profile.note')}</p>
    </div>
  );
}

/** One set of approval rules in words. */
export function RulesText({ rules }: { rules: ApprovalRules }) {
  const { t } = useI18n();
  return (
    <span>
      {rules.minApprovers === 1 ? t('rules.one') : t('rules.many', { count: rules.minApprovers })}{' '}
      {t(rules.allowSelfApproval ? 'rules.selfAllowed' : 'rules.selfRefused')}
    </span>
  );
}

/** Named groups of namespaces and repositories, each with the profile's rules for it. */
export function EnvironmentsStep({ draft, dispatch, errorFor, touch }: StepProps) {
  const { t } = useI18n();
  const policy = effectivePolicy(draft);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-ink-secondary">
        {t(draft.profile === 'starter' ? 'environments.introStarter' : 'environments.intro')}
      </p>
      {draft.environments.map((env, i) => {
        const at = (key: string) => `environment.${String(i)}.${key}`;
        const rules = policy.environments[i];
        const field = (key: 'name' | 'namespaces' | 'repos' | 'approvers', value: string) => {
          dispatch({ type: 'environmentField', index: i, key, value });
        };
        return (
          <fieldset
            key={i}
            data-environment={i}
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-4"
          >
            <legend className="px-1 font-bold">
              {env.name.trim() || t('environments.untitled', { n: i + 1 })}
            </legend>
            <TextField
              label={t('environments.name')}
              hint={t('environments.nameHint')}
              value={env.name}
              fieldId={at('name')}
              placeholder="production"
              required
              error={errorFor(at('name'))}
              onChange={(value) => {
                field('name', value);
              }}
              onBlur={() => {
                touch(at('name'));
              }}
            />
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm text-ink-secondary">{t('environments.productionHint')}</p>
              <Switch
                checked={env.production}
                label={t('environments.production')}
                onChange={(value) => {
                  dispatch({ type: 'environmentProduction', index: i, value });
                }}
              />
            </div>
            <TextField
              label={t('environments.namespaces')}
              hint={t('environments.namespacesHint')}
              value={env.namespaces}
              fieldId={at('namespaces')}
              placeholder="api, web"
              error={errorFor(at('namespaces'))}
              onChange={(value) => {
                field('namespaces', value);
              }}
              onBlur={() => {
                touch(at('namespaces'));
              }}
            />
            <TextField
              label={t('environments.repos')}
              hint={t('environments.reposHint')}
              value={env.repos}
              fieldId={at('repos')}
              placeholder="acme/deploy"
              error={errorFor(at('repos'))}
              onChange={(value) => {
                field('repos', value);
              }}
              onBlur={() => {
                touch(at('repos'));
              }}
            />
            <TextField
              label={t('environments.approvers')}
              hint={t('environments.approversHint')}
              value={env.approvers}
              fieldId={at('approvers')}
              placeholder="U0123ABCD, console:lead"
              error={errorFor(at('approvers'))}
              onChange={(value) => {
                field('approvers', value);
              }}
              onBlur={() => {
                touch(at('approvers'));
              }}
            />
            {rules ? (
              <p className="text-sm">
                <span className="font-medium">{t('environments.rules')}:</span>{' '}
                <RulesText rules={rules} />
              </p>
            ) : null}
            <div>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-primary-tint"
                onClick={() => {
                  dispatch({ type: 'environmentRemove', index: i });
                }}
              >
                {t('environments.remove', { name: env.name.trim() || String(i + 1) })}
              </button>
            </div>
          </fieldset>
        );
      })}
      <AddEnvironment draft={draft} dispatch={dispatch} />
    </div>
  );
}

function AddEnvironment({ draft, dispatch }: { draft: AgentDraft; dispatch: Dispatch<Action> }) {
  const { t } = useI18n();
  if (draft.environments.length >= MAX_ENVIRONMENTS) {
    return <p className="text-sm text-ink-secondary">{t('environments.max')}</p>;
  }
  const first = draft.environments.length === 0;
  return (
    <div className="flex flex-wrap gap-2">
      {first ? (
        <button
          type="button"
          className="rounded-lg bg-primary px-4 py-2 font-medium text-white hover:bg-primary-deep"
          onClick={() => {
            dispatch({ type: 'environmentAdd', production: true });
          }}
        >
          {t('environments.addProduction')}
        </button>
      ) : null}
      <button
        type="button"
        className="rounded-lg border border-line px-4 py-2 hover:bg-primary-tint"
        onClick={() => {
          dispatch({ type: 'environmentAdd', production: false });
        }}
      >
        {t('environments.add')}
      </button>
    </div>
  );
}

/** The rules the agent will apply, per environment, on the review step. */
export function ApprovalRulesSummary({
  draft,
  onAddEnvironments,
}: {
  draft: AgentDraft;
  onAddEnvironments: () => void;
}) {
  const { t } = useI18n();
  const policy = effectivePolicy(draft);
  return (
    <Section title={t('review.rules')}>
      <p className="text-sm text-ink-secondary">
        {t('review.rulesProfile', { profile: t(`profile.${policy.profile}` as MessageKey) })}
      </p>
      <ul data-testid="approval-rules" className="flex flex-col gap-2 text-sm">
        {policy.environments.map((env) => (
          <li key={env.name}>
            <span className="font-medium">
              <span>{env.name}</span>
              {env.production ? ` (${t('environments.production')})` : ''}:
            </span>{' '}
            <RulesText rules={env} />
          </li>
        ))}
        <li>
          <span className="font-medium">
            {t(policy.environments.length > 0 ? 'review.rulesElse' : 'review.rulesAll')}:
          </span>{' '}
          <RulesText rules={policy.default} />
        </li>
      </ul>
      {draft.profile === 'starter' && draft.environments.length === 0 ? (
        <div>
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-primary-tint"
            onClick={onAddEnvironments}
          >
            {t('review.addEnvironments')}
          </button>
        </div>
      ) : null}
    </Section>
  );
}
