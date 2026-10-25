import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../ship/exec.ts';
import { configYaml, posixPath, tempDir, testContext, writeConfig } from '../test-helpers.ts';
import { main } from '../cli.ts';
import { DEMO_CLUSTER, DEMO_SCENARIOS } from './demo.ts';
import { loadScenarios } from '../evals/scenario.ts';

/** A fake `kind`: lists the given clusters and records what it was asked. */
function fakeKind(clusters: string[]): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (args[0] === 'get' && args[1] === 'clusters') {
      return Promise.resolve({ code: 0, stdout: `${clusters.join('\n')}\n`, stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }) as Exec & { calls: string[][] };
  exec.calls = calls;
  return exec;
}

describe('kodra-agent demo (L3)', () => {
  it('runs three of the evaluation scenarios', async () => {
    expect((await loadScenarios(DEMO_SCENARIOS)).map((s) => s.id)).toEqual([
      'missing-env',
      'oomkilled',
      'bad-image-tag',
    ]);
  });

  it('never runs inside the agent itself', async () => {
    const exec = fakeKind([]);
    const t = testContext({
      exec,
      env: {
        KODRA_AGENT_NAMESPACE: 'kodra-agent',
        KODRA_AGENT_CONFIGMAP: 'cm',
        KODRA_AGENT_DEPLOYMENT: 'dep',
        KODRA_AGENT_SETTINGS_DIR: '/etc/kodra-agent-settings',
      },
    });
    expect(await main(['demo', '--provider', 'ollama', '--model', 'm'], t.ctx)).toBe(1);
    expect(t.output()).toContain('never inside the agent itself');
    expect(exec.calls).toEqual([]);
  });

  it('--cleanup deletes the demo cluster, and says when there is none', async () => {
    const exec = fakeKind([DEMO_CLUSTER, 'other']);
    const t = testContext({ exec });
    expect(await main(['demo', '--cleanup'], t.ctx)).toBe(0);
    expect(exec.calls).toContainEqual(['kind', 'delete', 'cluster', '--name', DEMO_CLUSTER]);
    expect(t.output()).toContain(`Deleted the kind cluster ${DEMO_CLUSTER}.`);

    const none = fakeKind(['other']);
    const again = testContext({ exec: none });
    expect(await main(['demo', '--cleanup'], again.ctx)).toBe(0);
    expect(none.calls.some((c) => c.includes('delete'))).toBe(false);
    expect(again.output()).toContain(`There is no ${DEMO_CLUSTER} cluster.`);
  });

  it('needs a model, and its key in the environment, before it creates anything', async () => {
    const exec = fakeKind([]);
    const missing = testContext({ exec });
    expect(await main(['demo', '--config', 'nope.yaml'], missing.ctx)).toBe(2);
    expect(missing.output()).toContain('give a model with --provider <name> --model <id>');

    const keyless = testContext({ exec });
    expect(
      await main(['demo', '--provider', 'anthropic', '--model', 'claude-sonnet-5-5'], keyless.ctx),
    ).toBe(2);
    expect(keyless.output()).toContain('Anthropic needs ANTHROPIC_API_KEY in the environment');

    // From a bundle: spec.model, with its own secret reference.
    const dir = await tempDir();
    const path = await writeConfig(
      configYaml({
        auditPath: posixPath(join(dir, 'audit.jsonl')),
        model: '    provider: ollama\n    name: local-model\n    baseUrl: http://ollama:11434',
      }),
      dir,
    );
    const fromConfig = testContext({ exec: fakeKind([]) });
    // Ollama needs no key, so it gets as far as kind (the fake one fails to give a kubeconfig).
    await main(['demo', '--config', path], fromConfig.ctx);
    expect(fromConfig.output()).toContain('investigated read-only with ollama/local-model');
    expect(exec.calls).toEqual([]);
  });
});
