import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { main } from './cli.ts';
import { testContext } from './test-helpers.ts';

async function run(argv: string[]) {
  const t = testContext();
  const code = await main(argv, t.ctx);
  return { code, stdout: t.term.stdout.join('\n'), stderr: t.term.stderr.join('\n') };
}

describe('kodra-agent CLI', () => {
  it.each([['--version'], ['-v']])('prints the package version for %s', async (flag) => {
    expect(await run([flag])).toEqual({ code: 0, stdout: pkg.version, stderr: '' });
  });

  it.each([[[]], [['--help']], [['-h']]])('prints help for %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    for (const word of [
      'Usage: kodra-agent <command>',
      'init',
      'doctor',
      '--non-interactive',
      '--dry-run',
      '--json',
    ]) {
      expect(result.stdout).toContain(word);
    }
  });

  it.each(['ship'])('says %s is not implemented yet', async (cmd) => {
    expect(await run([cmd])).toEqual({
      code: 1,
      stdout: '',
      stderr: `'${cmd}' is not implemented yet. Run 'kodra-agent --help'.`,
    });
  });

  it('rejects an unknown command and unknown options', async () => {
    expect((await run(['deploy-everything'])).code).toBe(2);
    const bad = await run(['doctor', '--frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Unknown option '--frobnicate'");
  });

  it('validates --target', async () => {
    expect(await run(['init', '--target', 'swarm'])).toEqual({
      code: 2,
      stdout: '',
      stderr: '--target must be compose or kubernetes.',
    });
  });

  it('reports a missing config file', async () => {
    const result = await run(['doctor', '--config', 'does-not-exist.yaml']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('FAIL');
    expect(result.stdout).toContain('Pass --config or set KODRA_AGENT_CONFIG');
  });
});
