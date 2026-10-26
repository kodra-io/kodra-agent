import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers.ts';
import { loadScenario, loadScenarios } from './scenario.ts';

describe('evals/scenarios (L3)', () => {
  it('has the ten scenarios from the launch plan, each valid', async () => {
    const all = await loadScenarios();
    expect(all.map((s) => s.id)).toEqual([
      'bad-image-tag',
      'crashloop',
      'missing-configmap-key',
      'missing-env',
      'oomkilled',
      'pvc-pending',
      'readiness-probe',
      'release-500s',
      'service-no-endpoints',
      'unschedulable',
    ]);
    for (const s of all) {
      expect(
        s.manifests.some((m) => m['kind'] === 'Namespace'),
        s.id,
      ).toBe(true);
      // Every scenario has a way to fail: at least two facts, or a fact and something it must not do.
      expect(s.expect.length + s.mustNot.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.update, s.id).toBe(s.updates.length > 0);
    }
  });

  it('keeps the requested order and refuses unknown ids', async () => {
    expect((await loadScenarios(['oomkilled', 'crashloop'])).map((s) => s.id)).toEqual([
      'oomkilled',
      'crashloop',
    ]);
    await expect(loadScenarios(['nope'])).rejects.toThrow('no such scenario: nope');
  });

  it('refuses a manifest outside the scenario namespace, and a bad pattern', async () => {
    const dir = join(await tempDir(), 'demo-one');
    await mkdir(dir);
    const scenario = [
      'id: demo-one',
      'title: t',
      'trigger: {question: why?}',
      'ready: [{state: running}]',
      "expect: [{fact: f, any: ['x']}]",
    ].join('\n');
    await writeFile(join(dir, 'scenario.yaml'), scenario);
    await writeFile(
      join(dir, 'manifests.yaml'),
      'apiVersion: v1\nkind: Namespace\nmetadata: {name: demo-one}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: c, namespace: default}\n',
    );
    await expect(loadScenario(dir)).rejects.toThrow('ConfigMap c must be in namespace demo-one');

    await writeFile(join(dir, 'scenario.yaml'), scenario.replace("['x']", "['(']"));
    await expect(loadScenario(dir)).rejects.toThrow('must be a valid regular expression');
  });
});
