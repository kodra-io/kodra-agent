import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  asSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
} from 'ai';

/** The AI SDK's model interface, from its LanguageModel union (no extra dependency). */
type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type LanguageModelV4CallOptions = Parameters<LanguageModelV4['doGenerate']>[0];
type LanguageModelV4Prompt = LanguageModelV4CallOptions['prompt'];

/**
 * B7: Claude Code as the model, with the user's own Claude sign-in instead of an API key.
 *
 * The agent runs the unmodified `claude` binary headless (`claude -p`). Claude Code's own
 * tools are all switched off (`--tools ""`): the only tools it has are the agent's, served to
 * it for one turn over a local MCP server, so every call still goes through the policy engine,
 * approvals, the redactor, and the audit log. The sign-in is Anthropic's own flow
 * (`claude auth login`), stored in Claude Code's config directory; the agent never reads it.
 */

/** The pinned build, downloaded on first start when this provider is chosen. */
export const CLAUDE_CODE = {
  version: '2.1.311',
  base: 'https://downloads.claude.ai/claude-code-releases',
  /** From the release's manifest.json (stable channel, built 2026-10-26). */
  sha256: {
    'linux-x64': '86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada',
    'linux-arm64': '2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3',
  } as Record<string, string>,
} as const;

/** The name of the agent's MCP server inside Claude Code: its tools are mcp__kodra__<name>. */
export const MCP_SERVER = 'kodra';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** Where Claude Code lives and signs in. */
export interface ClaudeCodeSetup {
  /** The binary to run. */
  binary: string;
  /** CLAUDE_CONFIG_DIR: the sign-in and Claude Code's own state, or null for its default. */
  configDir: string | null;
  /** The variables passed on, from the agent's environment (see claudeEnv). */
  env: Readonly<Record<string, string>>;
}

/**
 * Where the binary and the sign-in go. In the image, KODRA_CLAUDE_CODE_DIR is on the agent's
 * volume: the pinned binary under <dir>/<version>, the sign-in under <dir>/config. Without it
 * (a developer's machine), the `claude` on the PATH and its usual sign-in.
 */
export function claudeCodeSetup(
  env: Readonly<Record<string, string | undefined>>,
  oauthToken: string | undefined,
): ClaudeCodeSetup {
  const dir = env['KODRA_CLAUDE_CODE_DIR'];
  const configDir = dir ? join(dir, 'config') : null;
  return {
    binary: env['KODRA_CLAUDE_BIN'] ?? (dir ? pinnedBinary(dir) : 'claude'),
    configDir,
    env: claudeEnv(env, configDir, oauthToken),
  };
}

export function pinnedBinary(dir: string): string {
  return join(dir, CLAUDE_CODE.version, 'claude');
}

/** What Claude Code may inherit: never the agent's own secrets, like other connectors' tokens. */
const PASS_THROUGH = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  // The agent's network settings (docs/dev/network.md).
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Windows, for a developer's machine.
  'SYSTEMROOT',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ComSpec',
  'PATHEXT',
];

export function claudeEnv(
  env: Readonly<Record<string, string | undefined>>,
  configDir: string | null,
  oauthToken: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return {
    ...out,
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    // No telemetry, error reports, or auto-updates (golden rule 7; the version is pinned).
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };
}

export interface ClaudeArgs {
  model: string;
  systemPrompt: string;
  maxTurns: number;
  /** The MCP config file with the agent's tools, or null for a call without tools. */
  mcpConfig: string | null;
}

/** The command line: no tools of its own, no settings, hooks, memory, or saved sessions. */
export function claudeArgs(a: ClaudeArgs): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    a.model,
    '--system-prompt',
    a.systemPrompt,
    '--tools',
    '',
    '--strict-mcp-config',
    ...(a.mcpConfig ? ['--mcp-config', a.mcpConfig, '--allowedTools', `mcp__${MCP_SERVER}`] : []),
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns',
    String(a.maxTurns),
  ];
}

export interface StepTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One line of Claude Code's stream-json output, reduced to what the agent uses. */
export type ClaudeEvent =
  | { kind: 'init'; tools: string[] }
  | { kind: 'text'; message: string; text: string }
  | { kind: 'tool'; message: string; name: string }
  | { kind: 'usage'; message: string; usage: StepTokens }
  | {
      kind: 'result';
      subtype: string;
      isError: boolean;
      text: string;
      turns: number;
      /** The run's real totals; a message's usage is read when it starts (output too low). */
      usage: StepTokens | null;
    };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function tokensOf(usage: unknown): StepTokens {
  const u = (usage ?? {}) as Record<string, unknown>;
  const cacheRead = num(u['cache_read_input_tokens']);
  const cacheWrite = num(u['cache_creation_input_tokens']);
  // The agent counts input with its cached part, like the AI SDK does.
  return {
    input: num(u['input_tokens']) + cacheRead + cacheWrite,
    cacheRead,
    cacheWrite,
    output: num(u['output_tokens']),
  };
}

export function parseLine(line: string): ClaudeEvent[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (data['type'] === 'system' && data['subtype'] === 'init') {
    const tools = Array.isArray(data['tools']) ? data['tools'] : [];
    return [{ kind: 'init', tools: tools.filter((t): t is string => typeof t === 'string') }];
  }
  if (data['type'] === 'assistant') {
    const message = (data['message'] ?? {}) as Record<string, unknown>;
    const id = typeof message['id'] === 'string' ? message['id'] : '';
    const events: ClaudeEvent[] = [];
    const content = Array.isArray(message['content']) ? message['content'] : [];
    for (const block of content as Record<string, unknown>[]) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        events.push({ kind: 'text', message: id, text: block['text'] });
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        events.push({ kind: 'tool', message: id, name: block['name'] });
      }
    }
    if (message['usage'])
      events.push({ kind: 'usage', message: id, usage: tokensOf(message['usage']) });
    return events;
  }
  if (data['type'] === 'result') {
    return [
      {
        kind: 'result',
        subtype: typeof data['subtype'] === 'string' ? data['subtype'] : '',
        isError: data['is_error'] === true,
        text: typeof data['result'] === 'string' ? data['result'] : '',
        turns: num(data['num_turns']),
        usage: data['usage'] ? tokensOf(data['usage']) : null,
      },
    ];
  }
  return [];
}

/** Tools that are not the agent's: Claude Code must never run with any of them. */
export function foreignTools(tools: readonly string[]): string[] {
  return tools.filter((t) => !t.startsWith(MCP_PREFIX));
}

/** Plain words for the errors Claude Code reports, with what to do. */
export function claudeError(text: string): string {
  const said = text.trim().slice(0, 300) || 'no details';
  if (/login|log in|authenticat|oauth|api key|401/i.test(said)) {
    return `Claude Code is not signed in (${said}). Sign in with: kodra-agent claude-code login`;
  }
  if (/usage limit|rate limit|limit reached|429/i.test(said)) {
    return `Claude Code reached your plan's usage limit (${said}). Wait for it to reset, or use a model with an API key.`;
  }
  return `Claude Code failed: ${said}`;
}

/** A running `claude`: tests swap it for a fake. */
export type ClaudeSpawn = (
  binary: string,
  args: readonly string[],
  opts: { env: Record<string, string>; cwd: string },
) => ChildProcessWithoutNullStreams;

export const spawnClaude: ClaudeSpawn = (binary, args, opts) =>
  nodeSpawn(binary, [...args], { env: opts.env, cwd: opts.cwd, windowsHide: true });

export interface RunOptions {
  setup: ClaudeCodeSetup;
  model: string;
  systemPrompt: string;
  prompt: string;
  maxTurns: number;
  /** The agent's tools for this turn, or none for a call without tools. */
  tools?: Readonly<Record<string, Tool>>;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Each piece of the answer as it is written (one per text block, unredacted). */
  onText?: (text: string) => void;
  /** Each model call's tokens, once. Returning true stops the run (a budget or a pin). */
  onStep?: (tokens: StepTokens) => boolean | Promise<boolean>;
  spawn?: ClaudeSpawn;
}

export interface RunResult {
  text: string;
  /** 'stop', or 'tool-calls' when the turn limit or onStep ended it before an answer. */
  finishReason: 'stop' | 'tool-calls';
  usage: StepTokens;
}

const NO_TOKENS: StepTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function add(a: StepTokens, b: StepTokens): StepTokens {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** One `claude -p` run, in an empty private folder, with the agent's tools if any. */
export async function runClaudeCode(o: RunOptions): Promise<RunResult> {
  const work = await mkdtemp(join(tmpdir(), 'kodra-claude-'));
  const tools = o.tools && Object.keys(o.tools).length > 0 ? o.tools : null;
  const abort = new AbortController();
  const onAbort = () => {
    abort.abort(o.signal?.reason);
  };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let served: ServedTools | null = null;
  // The process ends after its answer: wait for it before removing its folder.
  let exited: Promise<void> = Promise.resolve();
  let kill = (): void => undefined;
  try {
    let mcpConfig: string | null = null;
    if (tools) {
      served = await serveTools(tools, abort.signal);
      mcpConfig = join(work, 'mcp.json');
      // The token is in a file only this user can read, not on the command line.
      await writeFile(mcpConfig, JSON.stringify(served.config), { mode: 0o600 });
    }
    const args = claudeArgs({
      model: o.model,
      systemPrompt: o.systemPrompt,
      maxTurns: o.maxTurns,
      mcpConfig,
    });
    const env = {
      ...o.setup.env,
      // Tool calls wait for a person's approval: let them take as long as the turn.
      MCP_TOOL_TIMEOUT: String(Math.max(o.timeoutMs, 60_000)),
    };
    return await new Promise<RunResult>((resolve, reject) => {
      const child = (o.spawn ?? spawnClaude)(o.setup.binary, args, { env, cwd: work });
      exited = new Promise((done) =>
        child.once('close', () => {
          done();
        }),
      );
      kill = () => child.kill('SIGKILL');
      let usage = NO_TOKENS;
      let text = '';
      let stderr = '';
      let buffer = '';
      let stopped = false;
      let settled = false;
      const counted = new Set<string>();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const stop = (why: Error | 'tool-calls') => {
        stopped = true;
        child.kill('SIGTERM');
        if (why === 'tool-calls') {
          finish(() => {
            resolve({ text, finishReason: 'tool-calls', usage });
          });
        } else {
          finish(() => {
            reject(why);
          });
        }
      };
      const timer = setTimeout(() => {
        const error = new Error('Claude Code took too long');
        error.name = 'TimeoutError';
        abort.abort(error);
        stop(error);
      }, o.timeoutMs);
      abort.signal.addEventListener('abort', () => {
        if (settled) return;
        const reason: unknown = abort.signal.reason;
        const error = reason instanceof Error ? reason : new Error('stopped');
        if (!(reason instanceof Error)) error.name = 'AbortError';
        stop(error);
      });
      const handle = async (event: ClaudeEvent) => {
        if (event.kind === 'init') {
          const foreign = foreignTools(event.tools);
          if (foreign.length > 0) {
            stop(
              new Error(
                `Claude Code offered tools of its own (${foreign.slice(0, 5).join(', ')}); the agent stopped it. Only the agent's tools may run.`,
              ),
            );
          }
        } else if (event.kind === 'text') {
          text = text ? `${text}\n\n${event.text}` : event.text;
          o.onText?.(event.text);
        } else if (event.kind === 'usage' && !counted.has(event.message)) {
          // Claude Code repeats a message's usage with each of its content blocks.
          counted.add(event.message);
          usage = add(usage, event.usage);
          if ((await o.onStep?.(event.usage)) === true) stop('tool-calls');
        } else if (event.kind === 'result') {
          // What the per-message counts missed (mostly output), as one last step, so the
          // audit log and the usage view show the real totals.
          if (event.usage) {
            const rest = {
              input: Math.max(0, event.usage.input - usage.input),
              cacheRead: Math.max(0, event.usage.cacheRead - usage.cacheRead),
              cacheWrite: Math.max(0, event.usage.cacheWrite - usage.cacheWrite),
              output: Math.max(0, event.usage.output - usage.output),
            };
            if (rest.input + rest.output > 0) {
              usage = add(usage, rest);
              await o.onStep?.(rest);
            }
          }
          if (event.subtype === 'error_max_turns') {
            finish(() => {
              resolve({ text, finishReason: 'tool-calls', usage });
            });
          } else if (event.isError) {
            finish(() => {
              reject(new Error(claudeError(event.text || stderr)));
            });
          } else {
            // The last block is the answer; earlier ones were said between tool calls.
            finish(() => {
              resolve({ text: event.text || text, finishReason: 'stop', usage });
            });
          }
        }
      };
      let queue = Promise.resolve();
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          for (const event of parseLine(line)) {
            queue = queue.then(() => (stopped ? undefined : handle(event))).catch(() => undefined);
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.on('error', (error) => {
        finish(() => {
          reject(
            new Error(
              `Claude Code could not start (${error.message}). Run: kodra-agent claude-code login`,
            ),
          );
        });
      });
      child.on('close', (code) => {
        void queue.then(() => {
          finish(() => {
            reject(
              new Error(claudeError(stderr || `it exited with code ${String(code)} and no answer`)),
            );
          });
        });
      });
      child.stdin.end(o.prompt);
    });
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    abort.abort();
    const late = setTimeout(kill, 5000);
    await exited;
    clearTimeout(late);
    await served?.close();
    await rm(work, { recursive: true, force: true });
  }
}

interface ServedTools {
  config: { mcpServers: Record<string, unknown> };
  close: () => Promise<void>;
}

/**
 * The agent's tools for one turn, as an MCP server on 127.0.0.1 behind a random bearer token.
 * Each call runs the tool's own execute: the policy check, approval, redaction, and audit.
 */
export async function serveTools(
  tools: Readonly<Record<string, Tool>>,
  signal: AbortSignal,
): Promise<ServedTools> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const listed = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name,
      description: tool.description ?? '',
      inputSchema: (await asSchema(tool.inputSchema).jsonSchema) as {
        type: 'object';
        [key: string]: unknown;
      },
    })),
  );
  const mcp = () => {
    // The low-level Server: McpServer needs zod shapes, and these tools carry JSON Schema.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: MCP_SERVER, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools[request.params.name];
      if (!tool?.execute) {
        return { isError: true, content: [{ type: 'text', text: 'No such tool.' }] };
      }
      try {
        const out: unknown = await tool.execute(request.params.arguments ?? {}, {
          toolCallId: randomUUID(),
          messages: [],
          abortSignal: signal,
          context: undefined,
        });
        return {
          content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: 'text', text: error instanceof Error ? error.message : 'The tool failed.' },
          ],
        };
      }
    });
    return server;
  };
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const http: HttpServer = createServer((req, res) => {
    if (!authorized(req) || req.url !== '/mcp') {
      res.writeHead(401).end();
      return;
    }
    // Stateless: a server and transport per request, as the SDK shows for this mode.
    const server = mcp();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport as unknown as Transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  // A tool call can wait minutes for a person's approval: no request time limit (Node's
  // default is 5 minutes). The turn's own timeout still ends it.
  http.requestTimeout = 0;
  http.timeout = 0;
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    config: {
      mcpServers: {
        [MCP_SERVER]: {
          type: 'http',
          url: `http://127.0.0.1:${String(port)}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
}

type PromptPart = { type: string; text?: string };

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as PromptPart[])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/**
 * The conversation as one prompt. Claude Code starts fresh each turn, so earlier messages are
 * replayed as text; tool results from earlier turns are left out (they were already answered).
 */
export function promptText(
  messages: readonly (ModelMessage | LanguageModelV4Prompt[number])[],
): string {
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const last = turns.at(-1);
  const earlier = turns
    .slice(0, -1)
    .map((m) => [m.role === 'user' ? 'User' : 'You', partsText(m.content)] as const)
    .filter(([, text]) => text.trim() !== '');
  const now = last ? partsText(last.content) : '';
  if (earlier.length === 0) return now;
  return [
    'Earlier in this conversation:',
    ...earlier.map(([who, text]) => `${who}: ${text}`),
    '',
    'Now:',
    now,
  ].join('\n\n');
}

function sdkUsage(t: StepTokens): LanguageModelUsage {
  return {
    inputTokens: t.input,
    outputTokens: t.output,
    totalTokens: t.input + t.output,
    inputTokenDetails: {
      noCacheTokens: t.input - t.cacheRead - t.cacheWrite,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite,
    },
    outputTokenDetails: { textTokens: t.output, reasoningTokens: undefined },
  };
}

export { sdkUsage };

/**
 * Claude Code as an AI SDK model, for calls without tools (the model test, a proposed fix, a
 * summary). A turn with tools goes through runTurn, which serves them over MCP instead.
 */
export class ClaudeCodeModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'claude-code';
  readonly modelId: string;
  readonly supportedUrls = {};
  readonly setup: ClaudeCodeSetup;
  readonly spawn: ClaudeSpawn | undefined;

  constructor(modelId: string, setup: ClaudeCodeSetup, spawn?: ClaudeSpawn) {
    this.modelId = modelId;
    this.setup = setup;
    this.spawn = spawn;
  }

  private async call(options: LanguageModelV4CallOptions): Promise<RunResult> {
    if (options.tools && options.tools.length > 0) {
      throw new Error('Claude Code runs tools only inside a turn (runTurn)');
    }
    const system = options.prompt
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    return runClaudeCode({
      setup: this.setup,
      model: this.modelId,
      systemPrompt: system || 'You are a helpful assistant.',
      prompt: promptText(options.prompt),
      maxTurns: 1,
      timeoutMs: 5 * 60_000,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      ...(this.spawn ? { spawn: this.spawn } : {}),
    });
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    const r = await this.call(options);
    return {
      content: [{ type: 'text' as const, text: r.text }],
      finishReason: { unified: 'stop' as const, raw: r.finishReason },
      usage: v4Usage(r.usage),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const r = await this.call(options);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: '0' });
        controller.enqueue({ type: 'text-delta', id: '0', delta: r.text });
        controller.enqueue({ type: 'text-end', id: '0' });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: r.finishReason },
          usage: v4Usage(r.usage),
        });
        controller.close();
      },
    });
    return { stream } as Awaited<ReturnType<LanguageModelV4['doStream']>>;
  }
}

function v4Usage(t: StepTokens) {
  return {
    inputTokens: {
      total: t.input,
      noCache: t.input - t.cacheRead - t.cacheWrite,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
    },
    outputTokens: { total: t.output, text: t.output, reasoning: undefined },
  };
}

export function isClaudeCode(model: unknown): model is ClaudeCodeModel {
  return model instanceof ClaudeCodeModel;
}

/** The platform name in Claude Code's release manifest, or null where there is no build. */
export function releasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== 'linux') return null;
  if (arch === 'x64') return 'linux-x64';
  if (arch === 'arm64') return 'linux-arm64';
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Downloads the pinned build into <dir>/<version>/claude once, checked against its SHA-256,
 * then never again. A failed check leaves nothing behind.
 */
export async function installClaudeCode(
  dir: string,
  opts: { fetch?: typeof fetch; platform?: string | null; log?: (line: string) => void } = {},
): Promise<string> {
  const target = pinnedBinary(dir);
  if (await exists(target)) return target;
  const platform = opts.platform === undefined ? releasePlatform() : opts.platform;
  const expected = platform ? CLAUDE_CODE.sha256[platform] : undefined;
  if (!platform || !expected) {
    throw new Error(
      `there is no pinned Claude Code build for ${process.platform}-${process.arch}; set KODRA_CLAUDE_BIN to a claude binary`,
    );
  }
  const url = `${CLAUDE_CODE.base}/${CLAUDE_CODE.version}/${platform}/claude`;
  opts.log?.(`Downloading Claude Code ${CLAUDE_CODE.version} (${platform}), about 300 MB…`);
  const res = await (opts.fetch ?? fetch)(url);
  if (!res.ok || !res.body)
    throw new Error(`downloading Claude Code failed: HTTP ${String(res.status)}`);
  await mkdir(join(dir, CLAUDE_CODE.version), { recursive: true, mode: 0o700 });
  const partial = `${target}.download`;
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(partial, { mode: 0o700 }),
  );
  const got = await sha256(partial);
  if (got !== expected) {
    await rm(partial, { force: true });
    throw new Error(
      `the Claude Code download did not match its SHA-256 (got ${got}); nothing was installed`,
    );
  }
  await chmod(partial, 0o755);
  await rename(partial, target);
  opts.log?.('Claude Code is installed.');
  return target;
}

/** The model names Claude Code takes: its aliases (the plan decides which it may use). */
export const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export type AuthStatus =
  { loggedIn: true; method: string; plan: string } | { loggedIn: false; reason: string };

/**
 * `claude auth status`: whether Claude Code is signed in, and how. Only the method and plan
 * are kept; the account's email and organization are never read out.
 */
export async function claudeAuthStatus(
  setup: ClaudeCodeSetup,
  spawn: ClaudeSpawn = spawnClaude,
  timeoutMs = 20_000,
): Promise<AuthStatus> {
  const work = await mkdtemp(join(tmpdir(), 'kodra-claude-'));
  try {
    const { code, stdout, error } = await new Promise<{
      code: number | null;
      stdout: string;
      error?: string;
    }>((resolve) => {
      let out = '';
      const child = spawn(setup.binary, ['auth', 'status'], { env: setup.env, cwd: work });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on(
        'data',
        (chunk: Buffer) => (out = (out + chunk.toString('utf8')).slice(-20_000)),
      );
      child.stderr.resume();
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, stdout: out, error: e.message });
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out });
      });
      child.stdin.end();
    });
    if (error !== undefined)
      return { loggedIn: false, reason: `Claude Code could not start (${error})` };
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // Older builds print text; the exit code still says whether it is signed in.
    }
    if (code !== 0 || data['loggedIn'] === false) {
      return { loggedIn: false, reason: 'Claude Code is not signed in' };
    }
    const text = (v: unknown) => (typeof v === 'string' && v ? v : 'unknown');
    return {
      loggedIn: true,
      method: text(data['authMethod']),
      plan: text(data['subscriptionType']),
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
