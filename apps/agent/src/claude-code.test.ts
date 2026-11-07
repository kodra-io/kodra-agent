import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dynamicTool, generateText, jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE,
  ClaudeCodeModel,
  claudeArgs,
  claudeAuthStatus,
  claudeCodeSetup,
  claudeEnv,
  claudeError,
  foreignTools,
  installClaudeCode,
  parseLine,
  pinnedBinary,
  promptText,
  releasePlatform,
  runClaudeCode,
  type ClaudeSpawn,
} from './claude-code.ts';
import { tempDir } from './test-helpers.ts';

const FAKE = fileURLToPath(new URL('./test-fixtures/fake-claude.ts', import.meta.url));

/** Runs the fake claude with node, as the real binary would run. */
const fakeSpawn: ClaudeSpawn = (_binary, args, opts) =>
  spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', FAKE, ...args],
    { env: { ...opts.env, PATH: process.env['PATH'] ?? '' }, cwd: opts.cwd },
  );

const setup = claudeCodeSetup({ PATH: '/usr/bin' }, undefined);

function echoTool(calls: unknown[]) {
  return dynamicTool({
    description: '[test, read] Echoes.',
    inputSchema: jsonSchema({ type: 'object', properties: { say: { type: 'string' } } }),
    execute: (input) => {
      calls.push(input);
      return Promise.resolve(`echo ${JSON.stringify(input)}`);
    },
  });
}

describe('Claude Code command line (B7)', () => {
  it('switches off its own tools, settings, hooks, and saved sessions', () => {
    const args = claudeArgs({
      model: 'sonnet',
      systemPrompt: 'rules',
      maxTurns: 7,
      mcpConfig: null,
    });
    const after = (f: string) => args[args.indexOf(f) + 1];
    expect(after('--tools')).toBe('');
    expect(after('--setting-sources')).toBe('');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--max-turns')).toBe('7');
    expect(after('--system-prompt')).toBe('rules');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    // No MCP config: no tools at all, and nothing is allowed.
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    const withTools = claudeArgs({
      model: 'sonnet',
      systemPrompt: 'r',
      maxTurns: 1,
      mcpConfig: '/x/mcp.json',
    });
    expect(withTools[withTools.indexOf('--allowedTools') + 1]).toBe('mcp__kodra');
    expect(withTools.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
  });

  it("passes on only network settings, never the agent's secrets", () => {
    const env = claudeEnv(
      {
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        GITHUB_TOKEN: 'ghp_secret',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        SLACK_BOT_TOKEN: 'xoxb',
      },
      '/data/claude-code/config',
      'oauth-token',
    );
    expect(env).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CONFIG_DIR: '/data/claude-code/config',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    });
  });

  it('runs the pinned build from the volume in the image, and claude on a laptop', () => {
    const image = claudeCodeSetup(
      { KODRA_CLAUDE_CODE_DIR: '/var/lib/kodra-agent/claude-code' },
      undefined,
    );
    expect(image.binary).toBe(pinnedBinary('/var/lib/kodra-agent/claude-code'));
    expect(image.configDir).toBe(join('/var/lib/kodra-agent/claude-code', 'config'));
    expect(claudeCodeSetup({}, undefined)).toMatchObject({ binary: 'claude', configDir: null });
    expect(claudeCodeSetup({ KODRA_CLAUDE_BIN: '/opt/claude' }, undefined).binary).toBe(
      '/opt/claude',
    );
  });

  it('reads the stream: tools at start, text, tool calls, usage once per message, the result', () => {
    expect(
      parseLine('{"type":"system","subtype":"init","tools":["mcp__kodra__a","Bash"]}'),
    ).toEqual([{ kind: 'init', tools: ['mcp__kodra__a', 'Bash'] }]);
    expect(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm1',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'tool_use', name: 'mcp__kodra__a' },
            ],
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
              output_tokens: 4,
            },
          },
        }),
      ),
    ).toEqual([
      { kind: 'text', message: 'm1', text: 'hi' },
      { kind: 'tool', message: 'm1', name: 'mcp__kodra__a' },
      {
        kind: 'usage',
        message: 'm1',
        usage: { input: 17, cacheRead: 10, cacheWrite: 5, output: 4 },
      },
    ]);
    expect(
      parseLine('{"type":"result","subtype":"error_max_turns","is_error":false,"num_turns":3}'),
    ).toEqual([
      {
        kind: 'result',
        subtype: 'error_max_turns',
        isError: false,
        text: '',
        turns: 3,
        usage: null,
      },
    ]);
    expect(parseLine('not json')).toEqual([]);
    expect(foreignTools(['mcp__kodra__a', 'mcp__other__b', 'Read'])).toEqual([
      'mcp__other__b',
      'Read',
    ]);
  });

  it('replays the conversation as text, without earlier tool results', () => {
    expect(promptText([{ role: 'user', content: 'Why?' }])).toBe('Why?');
    const text = promptText([
      { role: 'user', content: 'Is web up?' },
      { role: 'assistant', content: [{ type: 'text', text: 'It crashes.' }] },
      { role: 'tool', content: [] },
      { role: 'user', content: 'Fix it.' },
    ]);
    expect(text).toBe(
      'Earlier in this conversation:\n\nUser: Is web up?\n\nYou: It crashes.\n\n\n\nNow:\n\nFix it.',
    );
  });

  it('says what to do about a sign-in or a usage limit', () => {
    expect(claudeError('Invalid API key · Please run /login')).toContain(
      'kodra-agent claude-code login',
    );
    expect(claudeError('Claude AI usage limit reached|1762560000')).toContain('usage limit');
  });
});

describe('a Claude Code run (B7, fake binary)', () => {
  it("answers and calls the agent's tools only through the MCP server", async () => {
    const calls: unknown[] = [];
    const steps: number[] = [];
    const r = await runClaudeCode({
      setup,
      model: 'sonnet',
      systemPrompt: 'rules',
      prompt: 'CALL echo {"say":"hi"}\nCALL echo {"say":"again"}',
      maxTurns: 5,
      tools: { echo: echoTool(calls) },
      timeoutMs: 20_000,
      onStep: (t) => {
        steps.push(t.input);
        return false;
      },
      spawn: fakeSpawn,
    });
    expect(calls).toEqual([{ say: 'hi' }, { say: 'again' }]);
    expect(r).toMatchObject({
      finishReason: 'stop',
      text: 'done: echo {"say":"hi"} | echo {"say":"again"}',
    });
    // Three messages, each counted once though it had two blocks, then what their counts
    // missed: the result's totals have 100 output tokens, not 9.
    expect(steps).toEqual([17, 17, 17, 0]);
    expect(r.usage).toEqual({ input: 51, cacheRead: 15, cacheWrite: 6, output: 100 });
  });

  it('refuses to run when Claude Code has a tool of its own', async () => {
    const calls: unknown[] = [];
    await expect(
      runClaudeCode({
        setup,
        model: 'sonnet',
        systemPrompt: 'r',
        prompt: 'MODE:foreign\nCALL echo {}',
        maxTurns: 5,
        tools: { echo: echoTool(calls) },
        timeoutMs: 20_000,
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(/tools of its own \(Bash\)/);
  });

  it('stops at the turn limit, or when a step says to, for the summary call', async () => {
    const atLimit = await runClaudeCode({
      setup,
      model: 'sonnet',
      systemPrompt: 'r',
      prompt: 'MODE:turns',
      maxTurns: 3,
      timeoutMs: 20_000,
      spawn: fakeSpawn,
    });
    expect(atLimit).toMatchObject({
      finishReason: 'tool-calls',
      text: 'step 1\n\nstep 2\n\nstep 3',
    });
    const budget = await runClaudeCode({
      setup,
      model: 'sonnet',
      systemPrompt: 'r',
      prompt: 'MODE:turns',
      maxTurns: 9,
      timeoutMs: 20_000,
      onStep: () => true,
      spawn: fakeSpawn,
    });
    expect(budget.finishReason).toBe('tool-calls');
    expect(budget.usage.output).toBe(3);
  });

  it('reports a sign-in failure in plain words, and stops on time', async () => {
    await expect(
      runClaudeCode({
        setup,
        model: 'sonnet',
        systemPrompt: 'r',
        prompt: 'MODE:error Invalid API key · Please run /login',
        maxTurns: 1,
        timeoutMs: 20_000,
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(/not signed in.*claude-code login/);
    await expect(
      runClaudeCode({
        setup,
        model: 'sonnet',
        systemPrompt: 'r',
        prompt: 'MODE:hang',
        maxTurns: 1,
        timeoutMs: 1500,
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    const abort = new AbortController();
    const run = runClaudeCode({
      setup,
      model: 'sonnet',
      systemPrompt: 'r',
      prompt: 'MODE:hang',
      maxTurns: 1,
      timeoutMs: 20_000,
      signal: abort.signal,
      spawn: fakeSpawn,
    });
    setTimeout(() => {
      abort.abort();
    }, 300);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('starts with only the allowed environment, and no tools for a plain call', async () => {
    const r = await generateText({
      model: new ClaudeCodeModel(
        'haiku',
        claudeCodeSetup({ GITHUB_TOKEN: 'ghp_x' }, undefined),
        fakeSpawn,
      ),
      instructions: 'Be brief.',
      prompt: 'MODE:args',
    });
    const { args, env } = JSON.parse(r.text) as { args: string[]; env: string };
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args).not.toContain('--mcp-config');
    expect(env).not.toContain('GITHUB_TOKEN');
    expect(env).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
  });

  it('serves its tools only to a caller with the turn token', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const spy: ClaudeSpawn = (binary, args, opts) => {
      const config = args[args.indexOf('--mcp-config') + 1] ?? '';
      void readFile(config, 'utf8').then((text) => {
        seen = (
          JSON.parse(text) as {
            mcpServers: { kodra: { url: string; headers: Record<string, string> } };
          }
        ).mcpServers.kodra;
      });
      return fakeSpawn(binary, args, opts);
    };
    const calls: unknown[] = [];
    const tools = { echo: echoTool(calls) };
    let status = 0;
    await runClaudeCode({
      setup,
      model: 'sonnet',
      systemPrompt: 'r',
      prompt: 'CALL echo {"say":"hi"}',
      maxTurns: 3,
      tools,
      timeoutMs: 20_000,
      onStep: async () => {
        if (seen && status === 0) {
          const res = await fetch((seen as { url: string }).url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
            body: '{}',
          });
          status = res.status;
        }
        return false;
      },
      spawn: spy,
    });
    expect(status).toBe(401);
    expect((seen as { url: string } | null)?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(calls).toEqual([{ say: 'hi' }]);
  });

  it('reads whether it is signed in, without the account email', async () => {
    const fake =
      (stdout: string, code: number): ClaudeSpawn =>
      () =>
        spawn(process.execPath, [
          '-e',
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${String(code)})`,
        ]);
    expect(
      await claudeAuthStatus(
        setup,
        fake(
          JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            subscriptionType: 'max',
            email: 'a@b.c',
          }),
          0,
        ),
      ),
    ).toEqual({ loggedIn: true, method: 'claude.ai', plan: 'max' });
    expect(await claudeAuthStatus(setup, fake('{"loggedIn":false}', 1))).toMatchObject({
      loggedIn: false,
    });
  });
});

describe('installing the pinned Claude Code (B7)', () => {
  const bytes = Buffer.from('a fake claude binary');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const serve =
    (body: Buffer): typeof fetch =>
    () =>
      Promise.resolve(new Response(body));

  it('installs once, checked against the pinned SHA-256', async () => {
    const dir = await tempDir();
    CLAUDE_CODE.sha256['test-os'] = sha;
    const path = await installClaudeCode(dir, { fetch: serve(bytes), platform: 'test-os' });
    expect(path).toBe(pinnedBinary(dir));
    expect(await readFile(path)).toEqual(bytes);
    // Already there: nothing is downloaded.
    const again = await installClaudeCode(dir, {
      fetch: () => Promise.reject(new Error('no network')),
      platform: 'test-os',
    });
    expect(again).toBe(path);
  });

  it('keeps nothing when the download does not match, and refuses unknown platforms', async () => {
    const dir = await tempDir();
    CLAUDE_CODE.sha256['test-os'] = sha;
    await expect(
      installClaudeCode(dir, { fetch: serve(Buffer.from('tampered')), platform: 'test-os' }),
    ).rejects.toThrow(/did not match its SHA-256/);
    await expect(access(pinnedBinary(dir))).rejects.toThrow();
    await expect(installClaudeCode(dir, { platform: null })).rejects.toThrow(/KODRA_CLAUDE_BIN/);
    expect(releasePlatform('linux', 'x64')).toBe('linux-x64');
    expect(releasePlatform('darwin', 'arm64')).toBeNull();
  });
});
