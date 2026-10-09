import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileLogger } from './io.ts';
import { Redactor } from './redactor.ts';
import { tempDir } from './test-helpers.ts';

describe('fileLogger', () => {
  it('writes redacted JSON lines to an owner-only file, creating its folder', async () => {
    const redactor = new Redactor();
    redactor.add('connector-log-canary-5e1f');
    const path = join(await tempDir(), 'logs', 'connectors.log');
    const log = fileLogger(path, redactor);
    log.warn('connector stderr', { connector: 'gitlab', line: 'token connector-log-canary-5e1f' });
    log.info('second');

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', connector: 'gitlab' });
    expect(lines.join('\n')).not.toContain('connector-log-canary-5e1f');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('never throws when the file cannot be written', () => {
    const log = fileLogger(join('/', 'no-such-root-dir', '\0bad', 'x.log'), new Redactor());
    expect(() => {
      log.error('still fine');
    }).not.toThrow();
  });
});
