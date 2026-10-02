import { readFile } from 'node:fs/promises';
import type { SecretRef } from '@kodra-agent/schema';
import type { SecretUse } from './config.ts';
import type { Redactor } from './redactor.ts';

export type Resolved = { ok: true; value: string } | { ok: false; reason: string };

export interface ResolveOptions {
  env: Readonly<Record<string, string | undefined>>;
  redactor: Redactor;
  /** Reads a file; injectable for tests. */
  readFile?: (path: string) => Promise<string>;
}

/**
 * Resolves a secret reference. The value is registered with the redactor before it is
 * returned, so nothing downstream can print it. Reasons never contain the value.
 */
export async function resolveSecret(ref: SecretRef, opts: ResolveOptions): Promise<Resolved> {
  if (ref.scheme === 'env') {
    const value = opts.env[ref.name];
    if (value === undefined || value === '') {
      return { ok: false, reason: `${ref.name} is not set` };
    }
    opts.redactor.add(value);
    return { ok: true, value };
  }
  let value: string;
  try {
    value = await (opts.readFile ?? ((p) => readFile(p, 'utf8')))(ref.path);
  } catch {
    return { ok: false, reason: `cannot read ${ref.path}` };
  }
  // Editors and `echo` add one trailing newline; it is never part of the secret.
  value = value.replace(/\r?\n$/, '');
  if (value === '') return { ok: false, reason: `${ref.path} is empty` };
  opts.redactor.add(value);
  return { ok: true, value };
}

/** Resolves every secret a component needs, keyed by the manifest's secret key. */
export async function resolveAll(
  uses: readonly SecretUse[],
  opts: ResolveOptions,
): Promise<{ values: Record<string, string>; missing: { use: SecretUse; reason: string }[] }> {
  const values: Record<string, string> = {};
  const missing: { use: SecretUse; reason: string }[] = [];
  for (const use of uses) {
    const result = await resolveSecret(use.ref, opts);
    if (result.ok) values[use.spec.key] = result.value;
    else missing.push({ use, reason: result.reason });
  }
  return { values, missing };
}
