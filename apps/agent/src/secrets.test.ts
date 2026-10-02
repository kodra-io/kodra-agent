import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from './redactor.ts';
import { resolveSecret } from './secrets.ts';
import { tempDir } from './test-helpers.ts';

describe('resolveSecret', () => {
  it('reads an env reference and registers the value with the redactor', async () => {
    const redactor = new Redactor();
    const result = await resolveSecret(
      { scheme: 'env', name: 'MY_TOKEN' },
      { env: { MY_TOKEN: 'env-secret-value' }, redactor },
    );
    expect(result).toEqual({ ok: true, value: 'env-secret-value' });
    expect(redactor.redact('x env-secret-value')).toBe(`x ${REDACTED}`);
  });

  it.each([undefined, ''])('reports a missing env variable (%j) without a value', async (value) => {
    const result = await resolveSecret(
      { scheme: 'env', name: 'MY_TOKEN' },
      { env: { MY_TOKEN: value }, redactor: new Redactor() },
    );
    expect(result).toEqual({ ok: false, reason: 'MY_TOKEN is not set' });
  });

  it('reads a file reference and drops one trailing newline', async () => {
    const dir = await tempDir();
    const path = join(dir, 'kubeconfig');
    await writeFile(path, 'line one\nline two\n\n');
    const redactor = new Redactor();
    const result = await resolveSecret({ scheme: 'file', path }, { env: {}, redactor });
    expect(result).toEqual({ ok: true, value: 'line one\nline two\n' });
  });

  it('reports a missing or empty file by path only', async () => {
    const dir = await tempDir();
    const missing = join(dir, 'nope');
    expect(
      await resolveSecret({ scheme: 'file', path: missing }, { env: {}, redactor: new Redactor() }),
    ).toEqual({
      ok: false,
      reason: `cannot read ${missing}`,
    });
    const empty = join(dir, 'empty');
    await writeFile(empty, '\n');
    expect(
      await resolveSecret({ scheme: 'file', path: empty }, { env: {}, redactor: new Redactor() }),
    ).toEqual({
      ok: false,
      reason: `${empty} is empty`,
    });
  });
});
