import { generateBundle, validateDraft, type StepId } from '@kodra-agent/templates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type MessageKey } from './i18n.tsx';
import { useDraft } from './state.ts';
import {
  ConnectorsStep,
  DownloadStep,
  ModelStep,
  ReviewStep,
  StartStep,
  type StepProps,
} from './steps.tsx';
import { useIssueText } from './ui.tsx';
import { bundleZip, saveBlob } from './zip.ts';

type Step = StepId | 'download';

interface StepInfo {
  id: Step;
  label: MessageKey;
  heading: MessageKey;
}

const FIRST_STEP: StepInfo = { id: 'start', label: 'steps.start', heading: 'start.heading' };
const STEPS: readonly StepInfo[] = [
  FIRST_STEP,
  { id: 'model', label: 'steps.model', heading: 'model.heading' },
  { id: 'connectors', label: 'steps.connectors', heading: 'connectors.heading' },
  { id: 'review', label: 'steps.review', heading: 'review.heading' },
  { id: 'download', label: 'steps.download', heading: 'download.heading' },
];

export function App() {
  const { t, lang, setLang } = useI18n();
  const issueText = useIssueText();
  const { draft, dispatch, invalidLink } = useDraft();
  const [stepIndex, setStepIndex] = useState(0);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<ReadonlySet<Step>>(new Set());
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const issues = useMemo(() => validateDraft(draft), [draft]);
  const bundle = useMemo(() => generateBundle(draft), [draft]);
  const step = STEPS[stepIndex] ?? FIRST_STEP;
  const zipName = `${bundle.root}.zip`;

  const goTo = useCallback((index: number) => {
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, index)));
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [stepIndex]);

  // Field errors appear once a field was left, or once the user moved on from its step.
  // Dependency and coming-soon warnings show right away (SPEC section 7).
  const errorFor = useCallback(
    (field: string) => {
      const issue = issues.find(
        (i) =>
          i.field === field &&
          (i.code === 'dependency' ||
            i.code === 'coming-soon' ||
            touched.has(field) ||
            revealed.has(i.step)),
      );
      return issue ? issueText(issue) : undefined;
    },
    [issues, touched, revealed, issueText],
  );
  const touch = useCallback((field: string) => {
    setTouched((prev) => new Set(prev).add(field));
  }, []);
  const reveal = (ids: readonly Step[]) => {
    setRevealed((prev) => new Set([...prev, ...ids]));
  };

  const next = () => {
    reveal([step.id]);
    if (STEPS[stepIndex + 1]?.id === 'download') reveal(['start', 'model', 'connectors', 'review']);
    goTo(stepIndex + 1);
  };

  const download = async () => {
    setBusy(true);
    try {
      saveBlob(await bundleZip(bundle), zipName);
    } finally {
      setBusy(false);
    }
  };

  const stepProps: StepProps = { draft, dispatch, errorFor, touch };
  const stepHasIssues = (id: Step) => revealed.has(id) && issues.some((i) => i.step === id);

  return (
    <div className="min-h-screen">
      <a
        href="#step-content"
        className="absolute start-2 top-2 z-10 -translate-y-20 rounded-md bg-primary px-3 py-2 text-white focus:translate-y-0"
      >
        {t('app.skip')}
      </a>

      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div>
            <p className="font-heading text-sm font-bold text-primary">{t('app.productName')}</p>
            <h1 className="text-2xl font-bold text-ink">{t('app.title')}</h1>
          </div>
          <button
            type="button"
            lang={lang === 'en' ? 'ar' : 'en'}
            aria-label={t('app.switchLanguageLabel')}
            onClick={() => {
              setLang(lang === 'en' ? 'ar' : 'en');
            }}
            className="rounded-md border border-line px-3 py-2 hover:bg-primary-tint"
          >
            {t('app.switchLanguage')}
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6">
        <p className="text-ink-secondary">{t('app.tagline')}</p>
        <p
          data-testid="privacy-line"
          className="rounded-md border border-line bg-primary-tint px-4 py-3 font-medium text-ink"
        >
          {t('app.privacy')}
        </p>
        {invalidLink ? (
          <p role="status" className="rounded-md border border-line bg-white px-4 py-3">
            {t('app.invalidLink')}
          </p>
        ) : null}

        <nav aria-label={t('steps.label')}>
          <ol className="flex flex-wrap gap-2">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={i === stepIndex ? 'step' : undefined}
                  onClick={() => {
                    reveal(STEPS.slice(0, i).map((x) => x.id));
                    goTo(i);
                  }}
                  className={`inline-flex items-center rounded-full border py-1.5 ps-1.5 pe-4 text-sm ${
                    i === stepIndex
                      ? 'border-primary bg-primary text-white'
                      : 'border-line bg-white hover:bg-primary-tint'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`me-2 inline-flex size-5 items-center justify-center rounded-full text-xs ${
                      i === stepIndex ? 'bg-white text-primary' : 'bg-primary-tint text-ink'
                    }`}
                  >
                    {i + 1}
                  </span>
                  {t(s.label)}
                  {stepHasIssues(s.id) ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="ms-2 inline-block size-2 rounded-full bg-red-600"
                      />
                      <span className="sr-only">, {t('steps.hasProblems')}</span>
                    </>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
          <main
            id="step-content"
            className="flex min-w-0 flex-col gap-6 rounded-lg border border-line bg-white p-4 sm:p-6"
          >
            <h2 ref={headingRef} tabIndex={-1} className="text-xl font-bold outline-none">
              {t(step.heading)}
            </h2>
            {step.id === 'start' ? <StartStep {...stepProps} /> : null}
            {step.id === 'model' ? <ModelStep {...stepProps} /> : null}
            {step.id === 'connectors' ? <ConnectorsStep {...stepProps} /> : null}
            {step.id === 'review' ? (
              <ReviewStep
                {...stepProps}
                issues={issues}
                goTo={(id) => {
                  goTo(STEPS.findIndex((s) => s.id === id));
                }}
              />
            ) : null}
            {step.id === 'download' ? (
              <DownloadStep
                draft={draft}
                blocked={issues.length > 0}
                zipName={zipName}
                busy={busy}
                onDownload={() => {
                  void download();
                }}
              />
            ) : null}

            <div className="flex justify-between gap-4 border-t border-line pt-4">
              <button
                type="button"
                disabled={stepIndex === 0}
                onClick={() => {
                  goTo(stepIndex - 1);
                }}
                className="rounded-md border border-line px-4 py-2 hover:bg-primary-tint disabled:invisible"
              >
                {t('nav.back')}
              </button>
              {stepIndex < STEPS.length - 1 ? (
                <button
                  type="button"
                  onClick={next}
                  className="rounded-md bg-primary px-4 py-2 font-medium text-white hover:bg-primary-deep"
                >
                  {t('nav.next')}
                </button>
              ) : null}
            </div>
          </main>

          <Preview files={bundle.files} />
        </div>
      </div>
    </div>
  );
}

function Preview({ files }: { files: readonly { path: string; content: string }[] }) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = files[Math.min(active, files.length - 1)];

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const dir = document.documentElement.dir === 'rtl' ? -1 : 1;
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = index + dir;
    if (e.key === 'ArrowLeft') nextIndex = index - dir;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = files.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const wrapped = (nextIndex + files.length) % files.length;
    setActive(wrapped);
    tabRefs.current[wrapped]?.focus();
  };

  return (
    <aside
      aria-labelledby="preview-heading"
      className="flex min-w-0 flex-col gap-3 self-start rounded-lg border border-line bg-white p-4 lg:sticky lg:top-4"
    >
      <h2 id="preview-heading" className="text-lg font-bold">
        {t('preview.heading')}
      </h2>
      <div role="tablist" aria-label={t('preview.files')} className="flex flex-wrap gap-1">
        {files.map((file, i) => (
          <button
            key={file.path}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${String(i)}`}
            aria-selected={i === active}
            aria-controls="preview-panel"
            tabIndex={i === active ? 0 : -1}
            onClick={() => {
              setActive(i);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, i);
            }}
            dir="ltr"
            className={`rounded-md px-2 py-1 font-mono text-xs ${
              i === active ? 'bg-primary text-white' : 'bg-primary-tint text-ink hover:bg-line'
            }`}
          >
            {file.path}
          </button>
        ))}
      </div>
      <pre
        id="preview-panel"
        role="tabpanel"
        aria-labelledby={`tab-${String(active)}`}
        tabIndex={0}
        dir="ltr"
        data-testid="preview"
        className="max-h-[70vh] overflow-auto rounded-md bg-ink p-3 font-mono text-xs leading-relaxed text-white"
      >
        {current?.content}
      </pre>
    </aside>
  );
}
