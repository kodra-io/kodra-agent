import { z } from 'zod';

/**
 * How to get a secret or a setting's value (M28): steps the console shows next to the field,
 * each a sentence with an optional link and an optional command per operating system. The
 * commands only produce a value or a file for the person to paste; nothing runs them for them.
 *
 * Commands and links may use `{{key}}` for the connector's own settings (or, for an entry's
 * field, the entry's), and `{{agentName}}`. Lists are joined by spaces, or by commas with
 * `{{key:comma}}`. In a command or a link, a value is filled in only when it is plainly safe
 * to paste into a shell; anything else stays a visible `<key>` for the person to fill in.
 */

export const OPERATING_SYSTEMS = ['linux', 'macos', 'windows'] as const;
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

/** Placeholders every step may use besides the settings. */
export const GLOBAL_PLACEHOLDERS = ['agentName'] as const;

const command = z.string().min(1);

export const setupStepSchema = z.strictObject({
  text: z.string().min(1),
  /** An https link, or one under a URL setting, like `{{url}}/-/user_settings/...`. */
  link: z
    .string()
    .regex(/^(https:\/\/|\{\{[A-Za-z][A-Za-z0-9]*\}\}\/)/)
    .optional(),
  /** One command for every system, or one each (`windows` is PowerShell). */
  run: z
    .union([
      z.strictObject({ all: command }),
      z.strictObject({ linux: command, macos: command, windows: command }),
    ])
    .optional(),
});
export type SetupStep = z.infer<typeof setupStepSchema>;

/** A step as the console shows it: placeholders filled, one command per system. */
export interface FilledStep {
  text: string;
  link?: string;
  run?: Record<OperatingSystem, string>;
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)(:comma)?\}\}/g;
/** Characters a value may have to be pasted into bash, zsh, or PowerShell unquoted. */
const SAFE = /^[A-Za-z0-9._:/@+=,-]+$/;

/** The placeholder names a step uses. */
export function stepPlaceholders(step: SetupStep): string[] {
  const parts = [step.text, step.link ?? '', ...Object.values(step.run ?? {})];
  return [...new Set(parts.flatMap((p) => [...p.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '')))];
}

/** Characters a value may have in a sentence: one line of printable text. */
const PLAIN = /^[^\p{Cc}]+$/u;

/** A value as it goes into a step: lists joined; null when empty or not allowed there. */
function shown(value: unknown, separator: string, allowed: RegExp): string | null {
  const items = Array.isArray(value) ? value : [value];
  const texts = items.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''));
  if (texts.length === 0 || texts.some((t) => !allowed.test(t) || t.length > 300)) return null;
  return texts.join(separator);
}

function fill(template: string, values: Readonly<Record<string, unknown>>, allowed: RegExp) {
  return template.replace(
    PLACEHOLDER,
    (_, key: string, comma?: string) =>
      shown(values[key], comma ? ',' : ' ', allowed) ?? `<${key}>`,
  );
}

/** Fills each step's placeholders from the settings (unsafe or missing ones stay `<key>`). */
export function fillSteps(
  steps: readonly SetupStep[],
  values: Readonly<Record<string, unknown>>,
): FilledStep[] {
  return steps.map((step) => {
    const out: FilledStep = { text: fill(step.text, values, PLAIN) };
    if (step.link !== undefined) out.link = fill(step.link, values, SAFE);
    if (step.run) {
      const run = step.run;
      out.run = Object.fromEntries(
        OPERATING_SYSTEMS.map((os) => [os, fill('all' in run ? run.all : run[os], values, SAFE)]),
      ) as Record<OperatingSystem, string>;
    }
    return out;
  });
}
