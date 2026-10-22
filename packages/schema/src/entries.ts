import { z } from 'zod';
import type { ConfigField, EntryField } from './manifest.ts';
import { parseSecretRef, secretRefSchema } from './secret-ref.ts';

/**
 * `entries` settings (like one per database): a list of named entries. The name is what
 * tools, guards, and dashboard cards refer to; secrets are references to variables named for
 * the entry, never values.
 */

export type EntriesField = Extract<ConfigField, { kind: 'entries' }>;

/** An entry's name: lowercase letters, digits, and hyphens, like `orders` or `orders-replica`. */
export const ENTRY_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The variable an entry's secret lives in: KODRA_DB_ + ORDERS_REPLICA + _ + PASSWORD. */
export function entryEnvVar(field: EntriesField, name: string, secret: string): string {
  return `${field.envPrefix}${name.toUpperCase().replaceAll('-', '_')}_${secret}`;
}

/**
 * Whether an entry uses one of its secret fields: always, unless it goes with another field
 * (a tunnel's key with its host) that the entry leaves empty.
 */
export function entrySecretWanted(
  f: Extract<EntryField, { kind: 'secret' }>,
  entry: Readonly<Record<string, unknown>>,
): boolean {
  if (f.required || f.requiredWith === undefined) return true;
  const other = entry[f.requiredWith];
  return other !== undefined && other !== null && other !== '';
}

/** The entries of a setting value, keeping only objects with a name. */
export function entriesOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string',
  );
}

/**
 * The names a list setting holds: the entries themselves for a plain list, each entry's name
 * for an `entries` setting. Guards and dashboard cards read settings through this.
 */
export function listValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'object' && v !== null) {
      const name = (v as { name?: unknown }).name;
      return typeof name === 'string' ? [name] : [];
    }
    return [];
  });
}

function entryFieldSchema(field: EntryField): z.ZodType {
  const description = field.description;
  switch (field.kind) {
    case 'string': {
      let s = z.string().min(1);
      if (field.pattern) {
        s = s.regex(new RegExp(field.pattern), field.patternHint ?? 'has the wrong format');
      }
      return s.meta({ description });
    }
    case 'integer': {
      const n = z.int().min(field.min).max(field.max);
      return (field.default !== undefined ? n.default(field.default) : n).meta({ description });
    }
    case 'choice': {
      const e = z.enum(field.options as [string, ...string[]], {
        error: `must be ${field.options.join(', ')}`,
      });
      return (field.default !== undefined ? e.default(field.default) : e).meta({ description });
    }
    case 'boolean':
      return z.boolean().default(field.default).meta({ description });
    case 'secret':
      return secretRefSchema.meta({ description: `${description} A secret reference.` });
  }
}

/** The schema for an `entries` setting's value. */
export function entriesSchema(field: EntriesField): z.ZodType {
  const shape: Record<string, z.ZodType> = {
    name: z
      .string()
      .regex(ENTRY_NAME, 'must be lowercase letters, digits, and hyphens, like orders-replica')
      .max(40),
  };
  for (const f of field.fields) {
    const schema = entryFieldSchema(f);
    const hasDefault = 'default' in f && f.default !== undefined;
    shape[f.key] = 'required' in f && f.required && !hasDefault ? schema : schema.optional();
  }
  const entry = z.strictObject(shape).superRefine((value, ctx) => {
    const name = value['name'];
    for (const f of field.fields) {
      const present = value[f.key] !== undefined;
      if ('requiredWith' in f && f.requiredWith !== undefined && !present) {
        if (value[f.requiredWith] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [f.key],
            message: `is required with ${f.requiredWith}`,
          });
        }
      }
      if (f.kind !== 'secret' || !present || typeof name !== 'string') continue;
      // Only the entry's own variable (or a file): never another connector's secret.
      const ref = parseSecretRef(String(value[f.key]));
      const expected = entryEnvVar(field, name, f.envVar);
      if (ref.ok && ref.ref.scheme === 'env' && ref.ref.name !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: [f.key],
          message: `must be \${env:${expected}} (or a \${file:...} reference)`,
        });
      }
    }
  });
  return z
    .array(entry)
    .max(field.max, `at most ${String(field.max)} entries`)
    .superRefine((entries, ctx) => {
      const names = entries.map((e) => (e as { name?: unknown }).name);
      for (const [i, n] of names.entries()) {
        if (names.indexOf(n) !== i) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'name'],
            message: `${String(n)} is used twice`,
          });
        }
      }
    })
    .meta({ description: field.description });
}
