import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Redactor } from './redactor.ts';

/** Terminal output. Every write goes through the redactor, with no way around it. */
export interface Terminal {
  out(text: string): void;
  err(text: string): void;
}

export interface RawStreams {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export function redactingTerminal(streams: RawStreams, redactor: Redactor): Terminal {
  return {
    out: (text) => {
      streams.stdout.write(`${redactor.redact(text)}\n`);
    },
    err: (text) => {
      streams.stderr.write(`${redactor.redact(text)}\n`);
    },
  };
}

/** A terminal that collects output, for tests. */
export function memoryTerminal(
  redactor: Redactor,
): Terminal & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text) => stdout.push(redactor.redact(text)),
    err: (text) => stderr.push(redactor.redact(text)),
  };
}

/** Questions `init` asks. Secrets use hidden input and are never echoed. */
export interface Prompter {
  secret(message: string): Promise<string>;
  text(message: string): Promise<string>;
  choice<T extends string>(
    message: string,
    options: readonly { value: T; label: string }[],
  ): Promise<T>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
}

/** A small JSON-lines logger on stderr, redacted like everything else. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(
  write: (line: string) => void,
  redactor: Redactor,
  now: () => Date = () => new Date(),
): Logger {
  const log = (level: string, message: string, fields?: Record<string, unknown>) => {
    write(redactor.redact(JSON.stringify({ ts: now().toISOString(), level, message, ...fields })));
  };
  return {
    info: (m, f) => {
      log('info', m, f);
    },
    warn: (m, f) => {
      log('warn', m, f);
    },
    error: (m, f) => {
      log('error', m, f);
    },
  };
}

/** A JSON-lines logger into an owner-only file, redacted like everything else. */
export function fileLogger(path: string, redactor: Redactor): Logger {
  let ready = false;
  return jsonLogger((line) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break the agent; the audit log is the record that matters.
    }
  }, redactor);
}
