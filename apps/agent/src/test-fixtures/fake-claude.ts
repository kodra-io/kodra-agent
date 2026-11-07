import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * A stand-in for `claude -p --output-format stream-json` (B7 tests). It speaks the same
 * stream, connects to the MCP config it is given, and follows lines in its prompt:
 *   CALL <tool> <json args>   call one of the agent's tools
 *   MODE:foreign              report a built-in tool of its own (Bash) at start
 *   MODE:turns                use every turn without answering (error_max_turns)
 *   MODE:error <text>         fail with that text
 *   MODE:hang                 never answer
 *   MODE:args                 answer with its arguments and environment variable names
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
let prompt = '';
for await (const chunk of process.stdin) prompt += String(chunk);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 2,
  output_tokens: 3,
};
const say = (id: string, content: unknown[]) =>
  out({ type: 'assistant', message: { id, content, usage } });
const result = (text: string, extra: Record<string, unknown> = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    num_turns: 1,
    ...extra,
  });

let client: Client | null = null;
const tools: string[] = [];
const config = flag('--mcp-config');
if (config) {
  const server = (
    JSON.parse(readFileSync(config, 'utf8')) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    }
  ).mcpServers['kodra'];
  if (server) {
    client = new Client({ name: 'fake-claude', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      }) as unknown as Transport,
    );
    for (const t of (await client.listTools()).tools) tools.push(`mcp__kodra__${t.name}`);
  }
}
if (prompt.includes('MODE:foreign')) tools.push('Bash');
out({ type: 'system', subtype: 'init', tools, model: flag('--model') });

const error = /MODE:error (.+)/.exec(prompt);
if (prompt.includes('MODE:hang')) {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
} else if (error) {
  out({ type: 'result', subtype: 'success', is_error: true, result: error[1], num_turns: 1 });
} else if (prompt.includes('MODE:turns')) {
  const max = Number(flag('--max-turns'));
  for (let n = 1; n <= max; n++)
    say(`m${String(n)}`, [{ type: 'text', text: `step ${String(n)}` }]);
  out({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: max });
} else if (prompt.includes('MODE:args')) {
  const env = Object.keys(process.env).sort().join(',');
  say('m1', [{ type: 'text', text: 'args' }]);
  result(JSON.stringify({ args, env }));
} else {
  const outputs: string[] = [];
  let n = 0;
  for (const m of prompt.matchAll(/^CALL (\S+) (.+)$/gm)) {
    n += 1;
    const id = `m${String(n)}`;
    // Claude Code repeats a message's usage with each of its content blocks.
    say(id, [{ type: 'text', text: `calling ${m[1] ?? ''}` }]);
    say(id, [{ type: 'tool_use', name: `mcp__kodra__${m[1] ?? ''}`, input: {} }]);
    const r = (await client?.callTool({
      name: m[1] ?? '',
      arguments: JSON.parse(m[2] ?? '{}') as Record<string, unknown>,
    })) as { content: { text: string }[] } | undefined;
    outputs.push(r?.content.map((c) => c.text).join('') ?? 'no client');
  }
  const text = outputs.length ? `done: ${outputs.join(' | ')}` : 'hello';
  say(`m${String(n + 1)}`, [{ type: 'text', text }]);
  // The real totals: each message's usage above was read at its start (output too low).
  const k = n + 1;
  result(text, {
    num_turns: k,
    usage: {
      input_tokens: 10 * k,
      cache_read_input_tokens: 5 * k,
      cache_creation_input_tokens: 2 * k,
      output_tokens: 100,
    },
  });
}
await client?.close();
