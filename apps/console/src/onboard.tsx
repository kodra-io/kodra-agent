import { useCallback, useEffect, useId, useState } from 'react';
import {
  ApiError,
  get,
  post,
  SignedOut,
  type OnboardJob,
  type OnboardJobSummary,
  type OnboardView,
} from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { useLoad } from './load.ts';
import { MarkdownText } from './markdown.tsx';
import type { PageProps } from './pages.tsx';
import { Badge, Mono, Page } from './ui.tsx';

/** How often a running onboarding is read again. */
const POLL_MS = 2000;

const primary =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-white shadow-md hover:bg-primary-deep disabled:opacity-50';
const secondary =
  'inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-raised px-4 font-medium hover:bg-muted disabled:opacity-50';
const input = 'h-10 w-full rounded-lg border border-line-strong bg-surface px-3';

/**
 * Onboarding from the console (M30a): pick a configured repo, analyze it (the report, posted
 * to Slack), then open the pull request with its Dockerfile, CI, chart, and report. Pushing
 * waits for an approval in Approvals, like any change.
 */
export function ReposPage({ onSignedOut, me, go }: PageProps) {
  const { t } = useI18n();
  const load = useCallback(() => get<OnboardView>('onboard'), []);
  const { data, error, loading, reload } = useLoad(load, onSignedOut);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const repoId = useId();
  const branchId = useId();

  const running = data?.jobs.some((j) => j.state === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, reload]);

  const chosen = data?.repos.find((r) => r.repo === repo) ?? data?.repos[0];
  const start = (kind: 'analyze' | 'pr') => {
    if (!chosen) return;
    setProblem(null);
    post<{ id: string }>(`onboard/${kind}`, { repo: chosen.repo, branch })
      .then(({ id }) => {
        setOpen(id);
        reload();
      })
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
        else setProblem(e instanceof ApiError ? e.message : String(e));
      });
  };

  return (
    <Page
      title="repos.title"
      intro="repos.intro"
      onRefresh={reload}
      loading={loading}
      error={error}
    >
      {data && data.repos.length === 0 && (
        <div className="rounded-xl border border-line bg-raised p-5">
          <p>{t('repos.none')}</p>
          <button
            type="button"
            className={`${secondary} mt-3`}
            onClick={() => {
              go('/settings');
            }}
          >
            {t('repos.toSettings')}
          </button>
        </div>
      )}
      {data && chosen && (
        <section
          aria-labelledby="onboard-title"
          className="flex flex-col gap-3 rounded-xl border border-line bg-raised p-5"
        >
          <h2 id="onboard-title" className="flex items-center gap-2 text-lg font-semibold">
            {t('repos.onboard')} <Badge tone="plain">{t('repos.preview')}</Badge>
          </h2>
          <p className="text-[13px] text-ink-secondary">{t('repos.previewNote')}</p>
          <div className="flex flex-wrap gap-3">
            <label htmlFor={repoId} className="flex min-w-[240px] flex-1 flex-col gap-1 text-sm">
              <span className="font-medium">{t('repos.repo')}</span>
              <select
                id={repoId}
                className={input}
                value={chosen.repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                }}
              >
                {data.repos.map((r) => (
                  <option key={`${r.provider}:${r.repo}`} value={r.repo}>
                    {r.repo} ({r.provider === 'github' ? 'GitHub' : 'GitLab'})
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={branchId} className="flex min-w-[200px] flex-col gap-1 text-sm">
              <span className="font-medium">{t('repos.branch')}</span>
              <input
                id={branchId}
                className={input}
                placeholder={t('repos.branchHint')}
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value.trim());
                }}
              />
            </label>
          </div>
          <p className="text-sm text-ink-secondary">{t('repos.how')}</p>
          {!me.canApprove && (
            <p className="text-sm text-ink-secondary">{t('repos.approverOnly')}</p>
          )}
          {!chosen.canOpenPr && <p className="text-sm text-ink-secondary">{t('repos.readOnly')}</p>}
          {problem && (
            <p role="alert" className="text-sm font-semibold text-bad-text">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondary}
              disabled={!me.canApprove || running}
              onClick={() => {
                start('analyze');
              }}
            >
              {t('repos.analyze')}
            </button>
            <button
              type="button"
              className={primary}
              disabled={!me.canApprove || running || !chosen.canOpenPr}
              onClick={() => {
                start('pr');
              }}
            >
              {t('repos.openPr')}
            </button>
          </div>
        </section>
      )}
      {data && data.jobs.length > 0 && (
        <section aria-labelledby="jobs-title" className="mt-6">
          <h2 id="jobs-title" className="text-lg font-semibold">
            {t('repos.jobs')}
          </h2>
          <ul className="mt-3 flex flex-col gap-3">
            {data.jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                open={open === job.id}
                onToggle={() => {
                  setOpen(open === job.id ? null : job.id);
                }}
                onSignedOut={onSignedOut}
                onApprovals={() => {
                  go('/approvals');
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

function JobRow({
  job,
  open,
  onToggle,
  onSignedOut,
  onApprovals,
}: {
  job: OnboardJobSummary;
  open: boolean;
  onToggle: () => void;
  onSignedOut: () => void;
  onApprovals: () => void;
}) {
  const { t, time } = useI18n();
  const [detail, setDetail] = useState<OnboardJob | null>(null);
  // Read again while it runs, and when it ends.
  useEffect(() => {
    if (!open) return;
    get<OnboardJob>('onboard/job', { id: job.id })
      .then(setDetail)
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
      });
  }, [open, job.id, job.state, job.prUrl, job.risks, onSignedOut, job.endedAt]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open || job.state !== 'running') return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [open, job.state]);
  useEffect(() => {
    if (tick === 0) return;
    get<OnboardJob>('onboard/job', { id: job.id })
      .then(setDetail)
      .catch(() => undefined);
  }, [tick, job.id]);

  const tone = job.state === 'done' ? 'ok' : job.state === 'failed' ? 'bad' : 'plain';
  return (
    <li className="rounded-xl border border-line bg-raised p-4">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-start"
        onClick={onToggle}
      >
        <span className="flex flex-wrap items-center gap-2">
          {job.state === 'running' && <Icon name="spinner" size={16} className="animate-spin" />}
          <Mono>{job.repo}</Mono>
          <span>{t(job.kind === 'pr' ? 'repos.kind.pr' : 'repos.kind.analyze')}</span>
          <Badge tone={tone}>
            <span>{t(`repos.state.${job.state}` as MessageKey)}</span>
          </Badge>
          {job.risks !== null && (
            <span className="text-sm text-ink-secondary">
              {t('repos.counts', { risks: String(job.risks), gaps: String(job.gaps ?? 0) })}
            </span>
          )}
        </span>
        <span className="text-sm text-ink-secondary">
          {job.by} · {time(job.startedAt)}
        </span>
      </button>
      {job.prUrl && (
        <a
          href={job.prUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-block font-semibold text-primary-text underline"
        >
          {t('repos.prLink')}
        </a>
      )}
      {job.kind === 'pr' && job.state === 'running' && (
        <p className="mt-2 text-sm">
          {t('repos.waiting')}{' '}
          <button type="button" className="font-semibold underline" onClick={onApprovals}>
            {t('repos.toApprovals')}
          </button>
        </p>
      )}
      {open && detail && (
        <div className="mt-3 flex flex-col gap-3">
          {detail.report && (
            <div className="rounded-lg border border-line bg-surface p-3 text-sm">
              <MarkdownText text={detail.report} />
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-semibold">{t('repos.log')}</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line bg-surface p-2.5 font-mono text-[12.5px]">
              {detail.log.join('\n')}
            </pre>
          </details>
        </div>
      )}
    </li>
  );
}
