import type { DraftIssue } from '@kodra-agent/templates';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n, type MessageKey } from './i18n.tsx';

/** Turns a draft issue into a message in the current language. */
export function useIssueText() {
  const { t, lt } = useI18n();
  return (issue: DraftIssue): string => {
    switch (issue.code) {
      case 'required':
        return t('error.required');
      case 'url':
        return t('error.url');
      case 'pattern':
        return issue.hint ? lt(issue.hint) : t('error.pattern');
      case 'integer-range':
        return t('error.integerRange', { min: issue.min, max: issue.max });
      case 'name-format':
        return t('error.nameFormat');
      case 'entry-name':
        return t('error.entryName');
      case 'entry-duplicate':
        return t('error.entryDuplicate', { value: issue.value });
      case 'approver-format':
        return t('error.approverFormat', { value: issue.value });
      case 'approver-console-off':
        return t('error.approverConsoleOff', { value: issue.value });
      case 'dependency':
        return lt(issue.message);
      case 'coming-soon':
        return t('error.comingSoon');
      case 'environment-name':
        return t('error.environmentName');
      case 'namespace-format':
        return t('error.namespaceFormat', { value: issue.value });
      case 'repo-format':
        return t('error.repoFormat', { value: issue.value });
      case 'policy': {
        const v = issue.problem.vars;
        const who = t(`policy.who.${String(v['scope'])}` as MessageKey, { name: v['name'] ?? '' });
        switch (issue.problem.code) {
          case 'needs-other-approver':
            return t('policy.needsOther', { who });
          case 'needs-more-approvers':
            return v['self'] === 1
              ? t('policy.needsDifferent', { who, min: v['min'] ?? 0 })
              : t('policy.needsOthers', { who, min: v['min'] ?? 0, list: v['list'] ?? 0 });
          case 'duplicate-name':
            return t('policy.duplicateName', { name: v['name'] ?? '' });
          case 'empty-environment':
            return t('policy.emptyEnvironment', { name: v['name'] ?? '' });
          case 'namespace-taken':
            return t('policy.namespaceTaken', {
              namespace: v['namespace'] ?? '',
              owner: v['owner'] ?? '',
            });
          case 'repo-taken':
            return t('policy.repoTaken', { repo: v['repo'] ?? '', owner: v['owner'] ?? '' });
        }
        return issue.problem.message;
      }
      case 'schema':
        return t('error.schema', { message: issue.message });
    }
  };
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  placeholder?: string | undefined;
  inputMode?: 'text' | 'numeric' | 'url' | undefined;
  /** Keeps values like URLs and ids left-to-right inside Arabic pages. */
  ltr?: boolean;
  required?: boolean;
  onBlur?: () => void;
  fieldId?: string;
  /** Suggestions the browser offers while typing (a datalist). */
  suggestions?: readonly string[] | undefined;
}

export function TextField(props: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const listId = `${id}-list`;
  const describedBy = [props.hint ? hintId : '', props.error ? errorId : '']
    .filter(Boolean)
    .join(' ');
  const suggestions = props.suggestions ?? [];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {props.hint ? (
        <p id={hintId} className="text-sm text-ink-secondary">
          {props.hint}
        </p>
      ) : null}
      <input
        id={id}
        data-field={props.fieldId}
        type="text"
        value={props.value}
        dir={props.ltr ? 'ltr' : undefined}
        inputMode={props.inputMode}
        list={suggestions.length > 0 ? listId : undefined}
        placeholder={props.placeholder}
        required={props.required}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy || undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        onBlur={props.onBlur}
        className={`rounded-md border bg-white px-3 py-2 text-ink placeholder:text-ink-secondary/70 ${
          props.error ? 'border-red-700' : 'border-line'
        }`}
      />
      {suggestions.length > 0 ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {props.error ? (
        <p id={errorId} className="text-sm text-red-700">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** A choice from a short list of fixed values, like a database engine. */
export function SelectField(props: {
  label: string;
  value: string;
  options: readonly string[];
  /** Offers an empty choice first (a setting that can be left out). */
  allowEmpty?: boolean;
  required?: boolean;
  error?: string | undefined;
  fieldId?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={id}
        data-field={props.fieldId}
        value={props.value}
        dir="ltr"
        required={props.required}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errorId : undefined}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className={`rounded-md border bg-white px-3 py-2 text-ink ${
          props.error ? 'border-red-700' : 'border-line'
        }`}
      >
        {props.allowEmpty ? <option value="" /> : null}
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {props.error ? (
        <p id={errorId} className="text-sm text-red-700">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

interface Option<T extends string> {
  value: T;
  label: string;
  description?: string | undefined;
  disabled?: boolean;
  badge?: string | undefined;
}

export function RadioCards<T extends string>(props: {
  legend: string;
  name: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  columns?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">{props.legend}</legend>
      <div className={`grid gap-3 ${props.columns ?? 'sm:grid-cols-2'}`}>
        {props.options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary-tint has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary ${
              option.disabled ? 'cursor-not-allowed opacity-60' : 'border-line bg-white'
            }`}
          >
            <input
              type="radio"
              name={props.name}
              value={option.value}
              checked={props.value === option.value}
              disabled={option.disabled}
              onChange={() => {
                props.onChange(option.value);
              }}
              className="mt-1 accent-primary"
            />
            <span className="flex flex-col gap-1">
              <span className="font-medium">
                {option.label}
                {option.badge ? <Badge>{option.badge}</Badge> : null}
              </span>
              {option.description ? (
                <span className="text-sm text-ink-secondary">{option.description}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="ms-2 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-normal text-ink-secondary">
      {children}
    </span>
  );
}

export function Switch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.checked);
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        props.checked ? 'border-primary bg-primary' : 'border-ink-secondary bg-white'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-4 rounded-full transition-transform ${
          props.checked
            ? 'translate-x-6 bg-white rtl:-translate-x-6'
            : 'translate-x-1 bg-ink-secondary rtl:-translate-x-1'
        }`}
      />
    </button>
  );
}

export function CopyButton({ text, label }: { text: string | (() => string); label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="rounded-md border border-line bg-white px-3 py-1 text-sm hover:bg-primary-tint"
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            setCopied(false);
          }, 2000);
        });
      }}
    >
      <span aria-live="polite">
        {copied ? t('download.copied') : (label ?? t('download.copy'))}
      </span>
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}
