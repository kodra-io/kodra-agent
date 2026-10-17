import type { ModelMessage, Tool } from 'ai';

/**
 * A model's context window against what the agent sends. The agent's prompt (instructions,
 * every tool's description and schema, and the conversation) can be tens of thousands of
 * tokens with a few connectors on. Ollama runs a model with a smaller window by default
 * (4,096 tokens) and silently drops the start of a prompt that does not fit, so the model
 * answers without its instructions or most of its tools. This finds the window and the
 * prompt's size, so the agent can say so instead.
 */

/** A rough count: about four characters per token for English text and JSON. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function schemaOf(tool: Tool): unknown {
  const schema = (tool as { inputSchema?: unknown }).inputSchema;
  if (schema && typeof schema === 'object' && 'jsonSchema' in schema) {
    return schema.jsonSchema;
  }
  return schema ?? null;
}

/** The prompt's size in tokens: instructions, tool definitions, and the messages so far. */
export function promptTokens(
  instructions: string,
  messages: readonly ModelMessage[],
  tools: Readonly<Record<string, Tool>>,
): number {
  const toolText = Object.entries(tools)
    .map(
      ([name, tool]) =>
        `${name} ${typeof tool.description === 'string' ? tool.description : ''} ${JSON.stringify(schemaOf(tool))}`,
    )
    .join('\n');
  return (
    estimateTokens(instructions) +
    estimateTokens(toolText) +
    estimateTokens(JSON.stringify(messages))
  );
}

/** The prompt's size before any conversation: instructions and the hosted tools. */
export function baselinePromptTokens(
  instructions: string,
  tools: readonly { name: string; description: string; inputSchema: unknown }[],
): number {
  const toolText = tools
    .map((t) => `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`)
    .join('\n');
  return estimateTokens(instructions) + estimateTokens(toolText);
}

/** A model whose window is smaller than the agent's prompt. */
export interface ContextWarning {
  model: string;
  needed: number;
  window: number;
}

export interface OllamaContext {
  /** The window Ollama loaded the model with, or null when it is not loaded right now. */
  loaded: number | null;
  /** The most the model supports, from its own metadata. */
  max: number | null;
}

/**
 * Asks Ollama for the window it runs `model` with (`/api/ps`, only while it is loaded) and
 * the model's maximum (`/api/show`). Unknown values are null; nothing here throws.
 */
export async function ollamaContext(
  baseUrl: string,
  model: string,
  fetchFn: typeof fetch,
  timeoutMs = 5_000,
): Promise<OllamaContext> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const read = async (path: string, body?: unknown): Promise<unknown> => {
    try {
      const res = await fetchFn(`${base}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const [ps, show] = await Promise.all([read('/api/ps'), read('/api/show', { model })]);
  const running = (ps as { models?: unknown } | null)?.models;
  const entry = Array.isArray(running)
    ? (running as { name?: unknown; model?: unknown; context_length?: unknown }[]).find(
        (m) => m.name === model || m.model === model || m.name === `${model}:latest`,
      )
    : undefined;
  const loaded = typeof entry?.context_length === 'number' ? entry.context_length : null;
  const info = (show as { model_info?: unknown } | null)?.model_info;
  let max: number | null = null;
  if (info && typeof info === 'object') {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith('.context_length') && typeof value === 'number') max = value;
    }
  }
  return { loaded, max };
}

/** The advice when the prompt does not fit, in the words people see. */
export function contextAdvice(model: string, needed: number, window: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const suggest = Math.max(32_768, 2 ** Math.ceil(Math.log2(needed * 1.25)));
  return (
    `${model} runs with ${fmt(window)} tokens of context, and this agent needs about ${fmt(needed)} ` +
    `for its instructions, tools, and this conversation. Ollama would cut off the start, so the ` +
    `answer would be wrong. Set OLLAMA_CONTEXT_LENGTH to ${String(suggest)} where Ollama runs and ` +
    `restart Ollama, or turn off connectors you do not need.`
  );
}

/** Whether a call's prompt filled the window (Ollama cut it off). */
export function filledWindow(promptTokensUsed: number, window: number): boolean {
  return window > 0 && promptTokensUsed >= window * 0.98;
}

/** Below this, doctor flags the window: the instructions and a few tools alone come close. */
export const SMALL_CONTEXT = 16_384;
