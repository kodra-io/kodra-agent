import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isUsable } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { connectors, modelProviders } from './index.ts';

/** Stable JSON: object keys sorted, so only a real change moves the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  // undefined in an array, like JSON.stringify does.
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function fingerprint(manifest: unknown): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex').slice(0, 12);
}

const page = readFileSync(
  fileURLToPath(new URL('../../../docs/security/data-flow.md', import.meta.url)),
  'utf8',
);

describe('docs/security/data-flow.md', () => {
  // A manifest change (a new tool, server version, secret, or setting) changes what data goes
  // where: the page must be reviewed and its fingerprint updated in the same change.
  it('covers every available and preview connector and model provider at its current manifest', () => {
    const stale = [...connectors, ...modelProviders]
      .filter(isUsable)
      .map((m) => `${m.id}@${fingerprint(m)}`)
      .filter((tag) => !page.includes(`\`${tag}\``));
    expect(
      stale,
      'Review these entries in docs/security/data-flow.md, then set their "Reviewed manifest" lines',
    ).toEqual([]);
  });
});
