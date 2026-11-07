import { describe, expect, it } from 'vitest';
import type { ClaudeCodeSetup } from '../claude-code.ts';
import { testContext } from '../test-helpers.ts';
import { claudeCode, type Interactive } from './claude-code.ts';

describe('kodra-agent claude-code (B7)', () => {
  it('needs login, status, or logout', async () => {
    const { ctx, output } = testContext();
    expect(await claudeCode({ action: 'whoami' }, ctx)).toBe(2);
    expect(output()).toContain('Usage: kodra-agent claude-code login|status|logout');
  });

  it("runs Anthropic's own sign-in with only the allowed environment", async () => {
    const seen: { setup: ClaudeCodeSetup; args: readonly string[] }[] = [];
    const run: Interactive = (setup, args) => {
      seen.push({ setup, args });
      return Promise.resolve(1);
    };
    const { ctx, output } = testContext({
      env: {
        KODRA_CLAUDE_BIN: '/opt/claude',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-canary-4411',
        GITHUB_TOKEN: 'ghp_never_passed_on',
      },
    });
    expect(await claudeCode({ action: 'login' }, ctx, run)).toBe(1);
    expect(seen[0]?.args).toEqual(['auth', 'login']);
    expect(seen[0]?.setup.binary).toBe('/opt/claude');
    expect(seen[0]?.setup.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(output()).toContain('did not finish signing in');
    // The token was registered as soon as it was read.
    expect(ctx.redactor.redact('sk-ant-oat-canary-4411')).not.toContain('canary');
  });

  it('signs out through claude itself', async () => {
    const run: Interactive = (_setup, args) => Promise.resolve(args[1] === 'logout' ? 0 : 1);
    const { ctx } = testContext({ env: { KODRA_CLAUDE_BIN: '/opt/claude' } });
    expect(await claudeCode({ action: 'logout' }, ctx, run)).toBe(0);
  });
});
