import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEnvValue, parseEnvFile, renderEnvFile, writePrivateFile } from './env-file.ts';
import { tempDir } from './test-helpers.ts';

describe('.env format', () => {
  it.each([
    'plain-value_123',
    'has spaces and $dollar',
    "it's quoted",
    'both \' and " and \\ and $HOME',
    'multi\nline',
    '#not-a-comment',
    '',
  ])('round-trips %j', (value) => {
    const text = `KEY=${formatEnvValue(value)}\n`;
    expect(parseEnvFile(text).get('KEY')).toBe(value);
  });

  it('uses single quotes so Compose does not expand $ in values', () => {
    expect(formatEnvValue('a$b c')).toBe("'a$b c'");
  });

  it('parses comments, export, and unquoted inline comments', () => {
    const parsed = parseEnvFile('# c\nexport A=1\nB=two # note\n\nbad line\nC="x y"\n');
    expect([...parsed]).toEqual([
      ['A', '1'],
      ['B', 'two'],
      ['C', 'x y'],
    ]);
  });

  it('updates managed keys in place and keeps everything else', () => {
    const existing = '# mine\nOTHER=keep\nGITHUB_TOKEN=old\n\n';
    const out = renderEnvFile(
      existing,
      new Map([
        ['GITHUB_TOKEN', 'new'],
        ['NEW_KEY', 'v'],
      ]),
      '# header',
    );
    expect(out).toBe('# mine\nOTHER=keep\nGITHUB_TOKEN=new\nNEW_KEY=v\n');
  });

  it('starts a new file with the header', () => {
    expect(renderEnvFile(null, new Map([['A', '1']]), '# header')).toBe('# header\nA=1\n');
  });
});

describe('writePrivateFile', () => {
  it('replaces the file atomically and leaves no temp files', async () => {
    const dir = await tempDir();
    const path = join(dir, 'sub', '.env');
    await writePrivateFile(path, 'A=1\n');
    await writePrivateFile(path, 'A=2\n');
    expect(await readFile(path, 'utf8')).toBe('A=2\n');
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(dir, 'sub'))).toEqual(['.env']);
  });

  it.skipIf(process.platform === 'win32')('writes with owner-only permissions', async () => {
    const dir = await tempDir();
    const path = join(dir, '.env');
    await writeFile(path, 'old', { mode: 0o644 });
    await writePrivateFile(path, 'A=1\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
