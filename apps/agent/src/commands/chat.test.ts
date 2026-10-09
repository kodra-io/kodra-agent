import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { fakeLauncher } from '../test-fixtures/fake-connector.ts';
import { configYaml, posixPath, tempDir, testContext, writeConfig } from '../test-helpers.ts';

const answer = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 9, noCache: 9, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        warnings: [],
      }),
  });

// The first real-world test: Kubernetes on Docker Compose with no kubeconfig used to stop
// the whole agent. It must answer with the rest and say what is missing and how to fix it.
const KUBERNETES_NO_KUBECONFIG = [
  '    kubernetes:',
  '      enabled: true',
  '      config: {namespaces: [dev]}',
  "      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}",
].join('\n');

describe('kodra-agent chat', () => {
  it('answers without a connector whose secret is missing, and says how to fix it', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: KUBERNETES_NO_KUBECONFIG,
      }),
      dir,
    );
    const t = testContext({
      env: { ANTHROPIC_API_KEY: 'k' },
      modelFactory: () => answer('I can use no connectors right now.'),
      launcher: fakeLauncher(),
    });
    expect(await main(['chat', '--config', path, '--message', 'what can you see?'], t.ctx)).toBe(0);
    const out = t.output();
    expect(out).toContain('Kubernetes is not available: missing Kubernetes kubeconfig');
    expect(out).toContain(
      'On Docker Compose, Kubernetes needs a kubeconfig: copy it to secrets/kubeconfig in the bundle folder, then restart.',
    );
    expect(out).toContain('Kubernetes: not available (missing Kubernetes kubeconfig');
    expect(out).toContain('I can use no connectors right now.');
    expect(out).toContain('(9 tokens in, 3 out)');
  });

  it('still stops without the model key, since nothing works without the model', async () => {
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
      }),
      dir,
    );
    const t = testContext({ modelFactory: () => answer('never'), launcher: fakeLauncher() });
    expect(await main(['chat', '--config', path, '--message', 'hi'], t.ctx)).toBe(1);
    expect(t.output()).toContain('Missing Anthropic apiKey');
  });
});
