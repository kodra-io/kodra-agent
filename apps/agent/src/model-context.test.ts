import { dynamicTool, jsonSchema } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baselinePromptTokens,
  contextAdvice,
  estimateTokens,
  filledWindow,
  ollamaContext,
  promptTokens,
} from './model-context.ts';
import { fakeServer, json } from './test-helpers.ts';

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('prompt size', () => {
  it('counts instructions, tool definitions, and messages', () => {
    const t = dynamicTool({
      description: 'Lists pods in a namespace.',
      inputSchema: jsonSchema({ type: 'object', properties: { namespace: { type: 'string' } } }),
      execute: () => Promise.resolve('ok'),
    });
    const small = promptTokens('Be brief.', [], { pods_list: t });
    const bigger = promptTokens('Be brief.', [{ role: 'user', content: 'x'.repeat(4000) }], {
      pods_list: t,
    });
    expect(small).toBeGreaterThan(estimateTokens('Be brief.'));
    expect(bigger - small).toBeGreaterThanOrEqual(1000);
    expect(
      baselinePromptTokens('Be brief.', [
        { name: 'a', description: 'b', inputSchema: { type: 'object' } },
      ]),
    ).toBeGreaterThan(0);
  });

  it('says what to set, rounded up to a power of two, at least 32768', () => {
    expect(contextAdvice('gemma4:e4b', 52_000, 4096)).toBe(
      'gemma4:e4b runs with 4,096 tokens of context, and this agent needs about 52,000 for its instructions, tools, and this conversation. Ollama would cut off the start, so the answer would be wrong. Set OLLAMA_CONTEXT_LENGTH to 65536 where Ollama runs and restart Ollama, or turn off connectors you do not need.',
    );
    expect(contextAdvice('m', 5_000, 4096)).toContain('to 32768 ');
    expect(filledWindow(4096, 4096)).toBe(true);
    expect(filledWindow(3000, 4096)).toBe(false);
  });
});

describe('ollamaContext', () => {
  it('reads the loaded window and the model maximum', async () => {
    server = await fakeServer({
      '/api/ps': (_req, res) => {
        json(res, 200, {
          models: [{ name: 'gemma4:e4b', model: 'gemma4:e4b', context_length: 4096 }],
        });
      },
      '/api/show': (_req, res) => {
        json(res, 200, { model_info: { 'gemma4.context_length': 262_144 } });
      },
    });
    expect(await ollamaContext(server.url, 'gemma4:e4b', fetch)).toEqual({
      loaded: 4096,
      max: 262_144,
    });
    // The OpenAI-compatible address works too, and a model that is not loaded has no window.
    expect(await ollamaContext(`${server.url}/v1`, 'llama3.1', fetch)).toEqual({
      loaded: null,
      max: 262_144,
    });
  });

  it('never throws when Ollama is away', async () => {
    expect(await ollamaContext('http://127.0.0.1:1', 'x', fetch, 500)).toEqual({
      loaded: null,
      max: null,
    });
  });
});
