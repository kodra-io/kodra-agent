import { useEffect, useState } from 'react';
import type { FilledStep, OperatingSystem } from './api.ts';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';

/**
 * How to get a secret or a setting's value (M28): the manifest's steps, with this agent's
 * settings filled in by the agent, and each command for Linux, macOS, or Windows (PowerShell).
 * The chosen system is remembered in this browser only.
 */

const SYSTEMS: OperatingSystem[] = ['linux', 'macos', 'windows'];
const STORAGE_KEY = 'kodra-console-os';
const CHANGED = 'kodra-console-os';

function guessSystem(): OperatingSystem {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'macos';
  return 'linux';
}

function stored(): OperatingSystem {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'linux' || value === 'macos' || value === 'windows') return value;
  } catch {
    // Storage can be off; the guess is fine.
  }
  return guessSystem();
}

/** The system every steps panel on the page shows. */
function useSystem(): [OperatingSystem, (os: OperatingSystem) => void] {
  const [os, setOs] = useState(stored);
  useEffect(() => {
    const sync = () => {
      setOs(stored());
    };
    window.addEventListener(CHANGED, sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
    };
  }, []);
  return [
    os,
    (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not remembered, but still shown.
      }
      setOs(next);
      window.dispatchEvent(new Event(CHANGED));
    },
  ];
}

/** A link only when it is whole: one still holding a `<setting>` is shown as text. */
const usableLink = (link: string) => /^https?:\/\//.test(link) && !link.includes('<');

export function SetupSteps({ steps, open = false }: { steps: FilledStep[]; open?: boolean }) {
  const { t } = useI18n();
  const [os, setOs] = useSystem();
  if (steps.length === 0) return null;
  const commands = steps.some((s) => s.run);
  return (
    <details className="rounded-lg border border-line bg-raised p-3" open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{t('setup.how')}</summary>
      {commands && (
        <div
          role="tablist"
          aria-label={t('setup.system')}
          className="mt-3 inline-flex rounded-lg border border-line bg-surface p-0.5"
        >
          {SYSTEMS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={os === s}
              className={`rounded-md px-3 py-1 text-sm ${
                os === s ? 'bg-primary-tint font-semibold text-primary-text' : 'text-ink-secondary'
              }`}
              onClick={() => {
                setOs(s);
              }}
            >
              {t(`setup.os.${s}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
      <ol className="mt-3 flex list-decimal flex-col gap-3 ps-5 text-sm">
        {steps.map((step, i) => (
          <li key={i} className="flex flex-col gap-1.5">
            <span>{step.text}</span>
            {step.link &&
              (usableLink(step.link) ? (
                <a
                  href={step.link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="self-start font-semibold text-primary-text underline"
                >
                  {t('setup.open')}
                </a>
              ) : (
                <span className="font-mono text-xs break-all text-ink-secondary">{step.link}</span>
              ))}
            {step.run && <Command text={step.run[os]} />}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Command({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2.5 font-mono text-[12.5px] leading-relaxed">
        <code>{text}</code>
      </pre>
      <span className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 self-start rounded-md border border-line px-2 py-1 text-xs font-semibold"
          onClick={() => {
            navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
              },
              () => {
                setCopied(false);
              },
            );
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? t('setup.copied') : t('setup.copy')}
        </button>
        {copied === false && (
          <span className="text-xs text-ink-secondary">{t('setup.copyFailed')}</span>
        )}
      </span>
    </div>
  );
}
