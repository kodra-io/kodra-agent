import { createHmac, randomBytes } from 'node:crypto';

/**
 * Customer data in tool output (PLAN-v0.2 M13): card numbers, IBANs, emails, international
 * phone numbers, and the config's own patterns are replaced by placeholders before anything
 * leaves the agent. The same value always gets the same placeholder within one run, like
 * [email:7f3a], so the model can still see that one customer appears in many errors; the
 * placeholder comes from an HMAC whose key is random, made at startup, and never stored.
 * Checksums (Luhn, mod-97) and strict shapes keep timestamps, ids, and metrics untouched.
 */

export type DetectorName = 'cards' | 'ibans' | 'emails' | 'phones';

interface Detector {
  /** The label in placeholders and audit counts. */
  label: string;
  pattern: RegExp;
  /** The canonical form of a match, or null when it is not really one (a failed checksum). */
  accept: (match: string) => string | null;
}

/** Luhn checksum, for card numbers. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 check (ISO 13616): move the first four characters to the end, letters to numbers. */
export function ibanValid(iban: string): boolean {
  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let rest = 0;
  for (const ch of moved) {
    const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Card brands by their first digits (IIN), so a 14-digit timestamp is never a card. */
function cardPrefix(digits: string): boolean {
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  return (
    digits.startsWith('4') || // Visa
    (two >= 51 && two <= 55) || // Mastercard
    (four >= 2221 && four <= 2720) || // Mastercard
    two === 34 ||
    two === 37 || // American Express
    two === 35 || // JCB
    two === 36 ||
    two === 38 ||
    two === 30 || // Diners
    digits.startsWith('6011') ||
    digits.startsWith('65') ||
    (four >= 6440 && four <= 6499) || // Discover
    two === 62 // UnionPay
  );
}

const DETECTORS: Record<DetectorName, Detector> = {
  cards: {
    label: 'card',
    // Digit groups with optional single spaces or dashes; never part of a longer word or number.
    // A full stop may end the sentence after it; a decimal part may not follow.
    pattern: /(?<![\w.:/-])\d(?:[ -]?\d){12,18}(?![\w:/-]|\.\w)/g,
    accept: (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && cardPrefix(digits) && luhn(digits)
        ? digits
        : null;
    },
  },
  ibans: {
    label: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
    accept: (match) => {
      const iban = match.replace(/ /g, '');
      return iban.length >= 15 && iban.length <= 34 && ibanValid(iban) ? iban : null;
    },
  },
  emails: {
    label: 'email',
    pattern:
      /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-]|\.\w)/g,
    accept: (match) => match.toLowerCase(),
  },
  phones: {
    label: 'phone',
    // International only: + or 00, a country code, then 8 to 15 digits in all.
    pattern: /(?<![\w.+:/-])(?:\+|00)[1-9](?:[ .-]?\(?\d\)?){7,14}(?![\w:/-])/g,
    accept: (match) => {
      const digits = match.replace(/^00/, '').replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    },
  },
};

export interface MaskerOptions {
  redact: readonly DetectorName[];
  patterns: readonly { name: string; regex: string }[];
  /** The HMAC key; random per run unless a test gives one. */
  key?: Buffer;
}

export class DataMasker {
  private readonly key: Buffer;
  private readonly detectors: Detector[];

  constructor(opts: MaskerOptions) {
    this.key = opts.key ?? randomBytes(32);
    this.detectors = [
      ...opts.redact.map((name) => DETECTORS[name]),
      ...opts.patterns.map((p) => ({
        label: p.name,
        pattern: new RegExp(p.regex, 'g'),
        accept: (match: string) => match,
      })),
    ];
  }

  get active(): boolean {
    return this.detectors.length > 0;
  }

  /** The placeholder for a value: its label and four hex characters of a keyed hash. */
  placeholder(label: string, canonical: string): string {
    const tag = createHmac('sha256', this.key).update(`${label}\0${canonical}`).digest('hex');
    return `[${label}:${tag.slice(0, 4)}]`;
  }

  /** Masks every detected value; counts per label go into `counts` when given. */
  mask(text: string, counts?: Record<string, number>): string {
    let out = text;
    for (const d of this.detectors) {
      out = out.replace(d.pattern, (match) => {
        const canonical = d.accept(match);
        if (canonical === null) return match;
        if (counts) counts[d.label] = (counts[d.label] ?? 0) + 1;
        return this.placeholder(d.label, canonical);
      });
    }
    return out;
  }
}
