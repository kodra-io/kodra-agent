import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { fakeKubernetes, fakeServer, json, posixPath, tempDir } from '../test-helpers.ts';
import { fileBackend } from './config-backend.ts';
import { policyDiffers } from './policy-gate.ts';
import { moreAccess, patchConfigText, SettingsStore } from './settings.ts';

const OLD_KEY = 'sk-ant-old-provider-key-1a2b3c4d'; // gitleaks:allow
const NEW_KEY = 'sk-openai-new-provider-key-5e6f7a8b'; // gitleaks:allow

let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const yaml = (audit: string) => `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: switcher
spec:
  target: compose
  # The team's model.
  model:
    provider: anthropic
    name: claude-sonnet-5-5
    apiKey: \${env:ANTHROPIC_API_KEY}
  policy:
    approvals:
      approvers: ["console:admin"]
  audit:
    path: ${audit}
`;

const ok = {
  content: [{ type: 'text' as const, text: 'OK' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

async function setup(env: Record<string, string> = { ANTHROPIC_API_KEY: OLD_KEY }) {
  const dir = await tempDir();
  const configPath = join(dir, 'kodra-agent.yaml');
  const auditPath = join(dir, 'audit.jsonl');
  await writeFile(configPath, yaml(posixPath(auditPath)));
  await writeFile(
    join(dir, '.env'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
  server = await fakeServer({
    '/v1/models': (req, res) => {
      if (req.headers['authorization'] !== `Bearer ${NEW_KEY}`) {
        json(res, 401, { error: 'bad key' });
        return;
      }
      json(res, 200, { data: [{ id: 'gpt-5.1' }, { id: 'gpt-5.1-mini' }] });
    },
    '/api/tags': (_req, res) => {
      json(res, 200, { models: [{ name: 'llama3.1:8b' }] });
    },
  });
  const redactor = new Redactor();
  const tried: string[] = [];
  const store = new SettingsStore({
    backend: fileBackend(configPath),
    audit: new AuditLog(auditPath, redactor),
    redactor,
    env,
    fetch,
    kubernetes: fakeKubernetes(),
    probeTimeoutMs: 2000,
    endpoints: { openai: server.url },
    createModel: (model, secrets) => {
      tried.push(
        `${model.provider}/${model.name} ${secrets['apiKey'] === NEW_KEY ? 'new-key' : 'other'}`,
      );
      return new MockLanguageModelV4({ doGenerate: ok });
    },
  });
  return { dir, configPath, auditPath, store, tried, redactor };
}

describe('switching the model provider', () => {
  it('writes the whole model with a reference to the new key, keeping comments', () => {
    const text = patchConfigText(yaml('/var/lib/a.jsonl'), {
      model: { provider: 'openai', name: 'gpt-5.1', config: { baseUrl: 'https://gw.example.com' } },
    });
    expect(text).toContain(
      "  # The team's model.\n  model:\n    provider: openai\n    name: gpt-5.1",
    );
    expect(text).toContain('baseUrl: https://gw.example.com');
    expect(text).toContain('apiKey: ${env:OPENAI_API_KEY}');
    expect(text).not.toContain('anthropic');
    const before = parseAgentConfig(yaml('/var/lib/a.jsonl'));
    const after = parseAgentConfig(text);
    if (!before.ok || !after.ok) throw new Error('parse');
    // Where data goes changed: shown as more access, and gated like a policy change.
    expect(moreAccess(before.config, after.config)).toContainEqual({
      code: 'model',
      from: 'anthropic',
      to: 'openai (https://gw.example.com)',
    });
    expect(policyDiffers(before.config, after.config)).toBe(true);
  });

  it('checks the provider with the typed key and lists its models, writing nothing', async () => {
    const { dir, configPath, store } = await setup();
    const before = await readFile(configPath, 'utf8');
    const c = await store.switchCandidate({
      provider: 'openai',
      name: 'gpt-5.1',
      config: { baseUrl: server?.url ?? '' },
      secrets: { apiKey: NEW_KEY },
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.checks).toEqual([
      { check: 'openai.list-models', status: 'pass', message: 'API key accepted' },
    ]);
    expect(c.listed).toEqual({ ids: ['gpt-5.1', 'gpt-5.1-mini'] });
    expect([...c.env]).toEqual([['OPENAI_API_KEY', NEW_KEY]]);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(await readFile(join(dir, '.env'), 'utf8')).not.toContain(NEW_KEY);
  });

  it('refuses a wrong key, a missing key, and an unknown provider', async () => {
    const { store } = await setup();
    const base = { name: 'gpt-5.1', config: { baseUrl: server?.url ?? '' } };
    const wrong = await store.switchCandidate({
      provider: 'openai',
      ...base,
      secrets: { apiKey: 'sk-wrong-key-000' },
    });
    expect(wrong).toMatchObject({ ok: false, error: 'the provider check failed' });
    expect(JSON.stringify(wrong)).not.toContain('sk-wrong-key-000');
    expect(await store.switchCandidate({ provider: 'openai', ...base, secrets: {} })).toEqual({
      ok: false,
      error: 'OPENAI_API_KEY is needed',
    });
    expect(await store.switchCandidate({ provider: 'nope', ...base, secrets: {} })).toMatchObject({
      ok: false,
      error: 'unknown model provider',
    });
  });

  it('switches back with the key already in .env, and to Ollama with no key', async () => {
    const { store } = await setup({ ANTHROPIC_API_KEY: OLD_KEY, OPENAI_API_KEY: NEW_KEY });
    const back = await store.switchCandidate({
      provider: 'openai',
      name: 'gpt-5.1',
      config: { baseUrl: server?.url ?? '' },
      secrets: {},
    });
    expect(back.ok && back.env.size).toBe(0);
    const ollama = await store.switchCandidate({
      provider: 'ollama',
      name: 'llama3.1:8b',
      config: { baseUrl: server?.url ?? '' },
      secrets: {},
    });
    expect(ollama.ok && ollama.listed).toEqual({ ids: ['llama3.1:8b'] });
  });

  it('tries the model with the new key, then saves the key and the config, keeping the old key', async () => {
    const { dir, configPath, auditPath, store, tried } = await setup();
    const view = await store.view(null);
    const c = await store.switchCandidate({
      provider: 'openai',
      name: 'gpt-5.1',
      config: { baseUrl: server?.url ?? '' },
      secrets: { apiKey: NEW_KEY },
    });
    if (!c.ok) throw new Error(c.error);
    expect(await store.testCandidate(c.model, c.secrets)).toEqual({ ok: true });
    expect(tried).toEqual(['openai/gpt-5.1 new-key']);

    await store.writeEnv(c.env);
    const applied = await store.apply(c.patch, view.base, 'console:admin');
    expect(applied !== 'stale' && applied.ok).toBe(true);
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain(`OPENAI_API_KEY=${NEW_KEY}`);
    expect(env).toContain(`ANTHROPIC_API_KEY=${OLD_KEY}`);
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('provider: openai');
    expect(config).not.toContain(NEW_KEY);
    expect(await readFile(auditPath, 'utf8')).not.toContain(NEW_KEY);
  });

  it('lists the providers from their manifests, with whose key is already set', async () => {
    const { store } = await setup();
    const providers = await store.providers();
    expect(providers.map((p) => p.id)).toEqual(
      expect.arrayContaining(['anthropic', 'openai', 'azure-openai', 'bedrock', 'ollama']),
    );
    const anthropic = providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.secrets[0]).toMatchObject({ envVar: 'ANTHROPIC_API_KEY', set: true });
    expect(providers.find((p) => p.id === 'openai')?.secrets[0]?.set).toBe(false);
    expect(JSON.stringify(providers)).not.toContain(OLD_KEY);
  });
});
