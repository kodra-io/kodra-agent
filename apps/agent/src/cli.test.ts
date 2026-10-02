import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { runCli } from './cli.ts';

describe('kodra-agent CLI', () => {
  it.each([['--version'], ['-v']])('prints the package version for %s', (flag) => {
    expect(runCli([flag])).toEqual({ exitCode: 0, stdout: pkg.version, stderr: '' });
  });

  it.each([[[]], [['--help']], [['-h']]])('prints help for %j', (argv) => {
    const result = runCli(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: kodra-agent <command>');
    for (const cmd of ['init', 'doctor', 'run', 'chat', 'ship']) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('says a planned command is not implemented yet', () => {
    const result = runCli(['doctor']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("'doctor' is not implemented yet");
  });

  it('rejects an unknown command', () => {
    const result = runCli(['deploy-everything']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command 'deploy-everything'");
  });
});
