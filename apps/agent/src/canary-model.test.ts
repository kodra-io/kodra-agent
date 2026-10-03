import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import { fakeLauncher } from './test-fixtures/fake-connector.ts';
import { configYaml, posixPath, tempDir, testContext, writeConfig } from './test-helpers.ts';

/**
 * SPEC section 11, model payloads: secrets never reach the model, the terminal, or the
 * audit log during a chat. Canaries enter three ways: the user types one, a tool server
 * echoes the kubeconfig back in its output, and the model repeats one in its answer.
 */
const API_KEY = 'canary-model-key-5c1d9e7a';
const KUBE_TOKEN = 'canary-kube-token-3f8a2b6c';
const KUBECONFIG = `apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    token: ${KUBE_TOKEN}\n`;

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

describe('secret canary: model payloads', () => {
  it('keeps every secret out of the prompts, output, and audit log', async () => {
    const dir = await tempDir();
    const kubeconfigPath = join(dir, 'kubeconfig');
    await writeFile(kubeconfigPath, KUBECONFIG);
    const auditPath = join(dir, 'audit', 'audit.jsonl');
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(auditPath),
        model: '    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}',
        connectors: [
          '    kubernetes:',
          '      enabled: true',
          '      config: {namespaces: [api]}',
          `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfigPath)}}'}`,
        ].join('\n'),
      }),
      dir,
    );

    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'kubernetes__pods_log',
              input: JSON.stringify({ namespace: 'api', name: 'web-1' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        },
        {
          // A model that repeats a secret it should never have seen.
          content: [{ type: 'text', text: `The token is ${KUBE_TOKEN} and the key ${API_KEY}.` }],
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage,
          warnings: [],
        },
      ],
    });
    let keyGivenToModel: string | undefined;
    const t = testContext({
      env: { ANTHROPIC_API_KEY: API_KEY },
      launcher: fakeLauncher(),
      modelFactory: (_config, secrets) => {
        keyGivenToModel = secrets['apiKey'];
        return model;
      },
    });

    const code = await main(
      ['chat', '--config', path, '--message', `my key is ${API_KEY}; why is web-1 failing?`],
      t.ctx,
    );
    expect(code).toBe(0);
    // The provider client gets the key; nothing else does.
    expect(keyGivenToModel).toBe(API_KEY);

    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt)).join('\n');
    expect(prompts).toContain('connection refused');
    expect(prompts).toContain('leaked kubeconfig:');
    const everything = [
      prompts,
      t.output(),
      t.logLines.join('\n'),
      await readFile(auditPath, 'utf8'),
    ].join('\n');
    for (const canary of [API_KEY, KUBE_TOKEN]) {
      expect(everything.includes(canary), `leaked ${canary}`).toBe(false);
    }
  });
});
