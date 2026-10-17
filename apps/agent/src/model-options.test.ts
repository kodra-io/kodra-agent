import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnector, getModelProvider } from '@kodra-agent/connectors';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from './audit.ts';
import { AuditLog } from './audit.ts';
import type { Component } from './config.ts';
import { fileBackend } from './console/config-backend.ts';
import { SettingsStore } from './console/settings.ts';
import { listProviderModels, modelOptions, testModel } from './model-options.ts';
import { Redactor } from './redactor.ts';
import { fakeKubernetes, fakeServer, json, posixPath, tempDir } from './test-helpers.ts';

const KEY = 'sk-ant-model-options-key-9f8e7d6c'; // gitleaks:allow

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function modelComponent(id: string, settings: Record<string, unknown> = {}): Component {
  const manifest = getModelProvider(id) ?? getConnector(id);
  if (!manifest) throw new Error(id);
  return { id, displayName: manifest.displayName, manifest, settings, secrets: [] };
}

const ok = {
  content: [{ type: 'text' as const, text: 'OK' }],
  finishReason: { unified: 'stop' as const, raw: 'end_turn' },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

const record = (ts: string, input: number, output: number): AuditRecord => ({
  ts,
  event: 'model.call',
  actor: 'agent',
  usage: { input, cacheRead: 0, cacheWrite: 0, output },
});

describe('listProviderModels', () => {
  it('reads Anthropic and OpenAI model lists with the key, and Ollama tags without one', async () => {
    server = await fakeServer({
      '/v1/models': (req, res) => {
        const auth = req.headers['x-api-key'] ?? req.headers['authorization'];
        if (auth !== KEY && auth !== `Bearer ${KEY}`) {
          json(res, 401, {});
          return;
        }
        json(res, 200, {
          data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }, { id: 7 }],
        });
      },
      '/api/tags': (_req, res) => {
        json(res, 200, { models: [{ name: 'llama3.1:8b' }] });
      },
    });
    const ctx = {
      fetch,
      timeoutMs: 2000,
      endpoints: { anthropic: server.url, openai: server.url },
    };
    expect(await listProviderModels(modelComponent('anthropic'), { apiKey: KEY }, ctx)).toEqual({
      ids: ['claude-opus-5-5', 'claude-haiku-5-5'],
    });
    expect(server.requests[0]?.url).toBe('/v1/models?limit=1000');
    expect(await listProviderModels(modelComponent('openai'), { apiKey: KEY }, ctx)).toEqual({
      ids: ['claude-opus-5-5', 'claude-haiku-5-5'],
    });
    expect(
      await listProviderModels(modelComponent('ollama', { baseUrl: server.url }), {}, ctx),
    ).toEqual({ ids: ['llama3.1:8b'] });
    expect(await listProviderModels(modelComponent('anthropic'), { apiKey: 'wrong' }, ctx)).toEqual(
      {
        error: 'HTTP 401',
      },
    );
    // Bedrock has no list to read: the known models are offered.
    expect(await listProviderModels(modelComponent('bedrock'), {}, ctx)).toBeNull();
  });
});

describe('modelOptions', () => {
  it('lists priced models first, marks what the key can use, and prices this month on each', () => {
    const view = modelOptions({
      provider: 'anthropic',
      current: 'claude-sonnet-5-5',
      prices: {
        'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
        'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
      },
      listed: { ids: ['claude-sonnet-5-5', 'claude-new-6'] },
      records: [
        record('2026-10-02T10:00:00.000Z', 1_000_000, 100_000),
        // Last month does not count.
        record('2026-09-30T10:00:00.000Z', 9_000_000, 900_000),
      ],
      month: '2026-10',
    });
    expect(view.options.map((o) => [o.name, o.available, o.monthCost])).toEqual([
      ['claude-opus-5-5', false, 6],
      ['claude-sonnet-5-5', true, 3],
      ['claude-new-6', true, null],
    ]);
    expect(view.listError).toBeNull();
  });

  it('keeps the known models when the list cannot be read', () => {
    const view = modelOptions({
      provider: 'anthropic',
      current: 'my-custom-model',
      prices: { 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 } },
      listed: { error: 'HTTP 403' },
      records: [],
      month: '2026-10',
    });
    expect(view.options.map((o) => [o.name, o.available])).toEqual([
      ['claude-opus-5-5', null],
      ['my-custom-model', null],
    ]);
    expect(view.listError).toBe('HTTP 403');
  });
});

describe('testModel', () => {
  it('makes one tiny call, and redacts what a failure says', async () => {
    const good = new MockLanguageModelV4({ doGenerate: ok });
    expect(await testModel(good, new Redactor())).toEqual({ ok: true });
    expect(good.doGenerateCalls[0]?.maxOutputTokens).toBe(5);

    const redactor = new Redactor();
    redactor.add(KEY);
    const bad = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error(`model not found (key ${KEY})`)),
    });
    const result = await testModel(bad, redactor);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).toContain('model not found');
  });
});

describe('SettingsStore model picker', () => {
  async function setup(answers: (name: string) => boolean) {
    const dir = await tempDir();
    const configPath = join(dir, 'kodra-agent.yaml');
    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(
      configPath,
      `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: picker
spec:
  target: compose
  model:
    provider: anthropic
    name: claude-sonnet-5-5
    apiKey: \${env:ANTHROPIC_API_KEY}
  policy:
    approvals:
      approvers: ["console:admin"]
  audit:
    path: ${posixPath(auditPath)}
`,
    );
    server = await fakeServer({
      '/v1/models': (_req, res) => {
        json(res, 200, { data: [{ id: 'claude-opus-5-5' }] });
      },
    });
    const redactor = new Redactor();
    const tried: string[] = [];
    const store = new SettingsStore({
      backend: fileBackend(configPath),
      audit: new AuditLog(auditPath, redactor),
      redactor,
      env: { ANTHROPIC_API_KEY: KEY },
      fetch,
      kubernetes: fakeKubernetes(),
      probeTimeoutMs: 2000,
      endpoints: { anthropic: server.url },
      createModel: (model, secrets) => {
        tried.push(`${model.name} ${secrets['apiKey'] === KEY ? 'with-key' : 'no-key'}`);
        return new MockLanguageModelV4({
          doGenerate: answers(model.name)
            ? ok
            : () => Promise.reject(new Error('model: not_found_error')),
        });
      },
    });
    return { store, tried };
  }

  it('lists the options with the agent key, and tries a new model before it is saved', async () => {
    const { store, tried } = await setup((name) => name === 'claude-opus-5-5');
    const view = await store.modelOptions([]);
    expect(view.current).toBe('claude-sonnet-5-5');
    expect(view.options.find((o) => o.name === 'claude-opus-5-5')?.available).toBe(true);
    expect(JSON.stringify(view)).not.toContain(KEY);

    expect(await store.checkModelChange({ model: { name: 'claude-opus-5-5' } })).toBeNull();
    expect(await store.checkModelChange({ model: { name: 'claude-typo' } })).toMatch(
      /^claude-typo did not answer: .*not_found_error/,
    );
    // The current model and other patches need no call.
    expect(await store.checkModelChange({ model: { name: 'claude-sonnet-5-5' } })).toBeNull();
    expect(await store.checkModelChange({ limits: { maxSteps: 5 } })).toBeNull();
    expect(tried).toEqual(['claude-opus-5-5 with-key', 'claude-typo with-key']);

    expect(await store.testModel('rm -rf /')).toEqual({
      ok: false,
      error: 'that is not a model name',
    });
  });
});
