import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import {
  claudeAuthStatus,
  claudeCodeSetup,
  installClaudeCode,
  type ClaudeCodeSetup,
} from '../claude-code.ts';
import type { Context } from '../context.ts';

export interface ClaudeCodeOptions {
  action: string | undefined;
}

/** Runs `claude <args>` on this terminal; tests pass a fake. */
export type Interactive = (setup: ClaudeCodeSetup, args: readonly string[]) => Promise<number>;

const interactive: Interactive = (setup, args) =>
  new Promise((resolve) => {
    // Anthropic's own sign-in flow, on this terminal: the agent never sees what is typed.
    const child = spawn(setup.binary, [...args], { env: setup.env, stdio: 'inherit' });
    child.on('error', () => {
      resolve(127);
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });

const USAGE = 'Usage: kodra-agent claude-code login|status|logout';

/**
 * B7: sign the agent's Claude Code in or out, or show whether it is signed in. On the agent:
 * `docker compose exec -it kodra-agent kodra-agent claude-code login` (or `kubectl exec -it`).
 */
export async function claudeCode(
  opts: ClaudeCodeOptions,
  ctx: Context,
  run: Interactive = interactive,
): Promise<number> {
  if (opts.action !== 'login' && opts.action !== 'status' && opts.action !== 'logout') {
    ctx.term.err(USAGE);
    return 2;
  }
  const token = ctx.env['CLAUDE_CODE_OAUTH_TOKEN'];
  // Registered as soon as it is read, so nothing printed can show it.
  if (token) ctx.redactor.add(token);
  const setup = claudeCodeSetup(ctx.env, token);
  const dir = ctx.env['KODRA_CLAUDE_CODE_DIR'];
  if (dir && !ctx.env['KODRA_CLAUDE_BIN']) {
    try {
      await installClaudeCode(dir, {
        fetch: ctx.fetch,
        log: (line) => {
          ctx.term.err(line);
        },
      });
    } catch (error) {
      ctx.term.err(
        `Claude Code is not installed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  if (setup.configDir) await mkdir(setup.configDir, { recursive: true, mode: 0o700 });

  if (opts.action === 'status') {
    const status = await claudeAuthStatus(setup);
    if (!status.loggedIn) {
      ctx.term.out(`${status.reason}. Sign in with: kodra-agent claude-code login`);
      return 1;
    }
    ctx.term.out(`Claude Code is signed in (${status.method}, plan: ${status.plan}).`);
    return 0;
  }
  if (opts.action === 'logout') {
    const code = await run(setup, ['auth', 'logout']);
    return code === 0 ? 0 : 1;
  }
  ctx.term.out(
    "Signing in to Claude Code with Anthropic's own login. Open the link it shows, sign in, and paste the code back here.",
  );
  const code = await run(setup, ['auth', 'login']);
  if (code !== 0) {
    ctx.term.err('Claude Code did not finish signing in.');
    return 1;
  }
  const status = await claudeAuthStatus(setup);
  if (!status.loggedIn) {
    ctx.term.err(`${status.reason}.`);
    return 1;
  }
  ctx.term.out(
    `Signed in (${status.method}, plan: ${status.plan}). Set spec.model.provider to claude-code and restart the agent.`,
  );
  return 0;
}
