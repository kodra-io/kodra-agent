import { manifestSchema, modelSchema, type Manifest } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { connectors, getConnector, getModelProvider, modelProviders } from './index.ts';

const all: readonly Manifest[] = [...connectors, ...modelProviders];

describe('connector registry', () => {
  it('lists the MVP catalog from SPEC section 6', () => {
    const available = connectors.filter((c) => c.status === 'available').map((c) => c.id);
    const comingSoon = connectors.filter((c) => c.status === 'coming-soon').map((c) => c.id);
    expect(available.sort()).toEqual(
      [
        'aws',
        'docker',
        'github',
        'github-actions',
        'gitlab',
        'gitlab-ci',
        'grafana',
        'kubernetes',
        'prometheus',
        'slack',
      ].sort(),
    );
    expect(comingSoon.sort()).toEqual(
      ['azure', 'azure-devops', 'bitbucket', 'gcp', 'jenkins', 'teams'].sort(),
    );
    expect(modelProviders.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'azure-openai',
      'bedrock',
      'ollama',
    ]);
  });

  it.each(all.map((m) => [m.id, m] as const))('%s is a valid manifest', (_id, manifest) => {
    const result = manifestSchema.safeParse(manifest);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('has unique ids', () => {
    const ids = all.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps model providers in the model category and connectors out of it', () => {
    expect(modelProviders.every((p) => p.category === 'model')).toBe(true);
    expect(connectors.every((c) => c.category !== 'model')).toBe(true);
  });

  it('only references connectors that exist in requires rules', () => {
    for (const manifest of all) {
      for (const rule of manifest.requires) {
        for (const alt of rule.anyOf) {
          if ('connector' in alt) expect(getConnector(alt.connector), alt.connector).toBeDefined();
        }
      }
    }
  });

  it('defaults to safe access: monitoring and cloud connectors are read-only only', () => {
    for (const c of connectors.filter((m) => ['monitoring', 'cloud'].includes(m.category))) {
      expect(
        c.accessLevels.filter((l) => l !== 'read-only'),
        c.id,
      ).toEqual([]);
    }
  });

  it('gives every secret a probe and a distinct env var', () => {
    const seen = new Map<string, string>();
    for (const manifest of all) {
      for (const secret of manifest.secrets) {
        const owner = `${manifest.id}.${secret.key}`;
        const previous = seen.get(secret.envVar);
        expect(previous, `${secret.envVar} used by ${previous ?? ''} and ${owner}`).toBeUndefined();
        seen.set(secret.envVar, owner);
        expect(secret.probe.startsWith(`${manifest.id}.`), owner).toBe(true);
      }
    }
  });

  it('blocks every tool until an MCP server is chosen (M4)', () => {
    for (const manifest of all) {
      expect(manifest.runtime, manifest.id).toBeNull();
      expect(manifest.tools, manifest.id).toEqual({});
    }
  });

  it('has Arabic copy for every text field', () => {
    const texts = JSON.stringify(all);
    const pairs = [...texts.matchAll(/"ar":"([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(pairs.length).toBeGreaterThan(50);
    for (const ar of pairs) expect(ar).toMatch(/[؀-ۿ]/);
  });

  it('uses no em dashes in copy', () => {
    expect(JSON.stringify(all)).not.toContain('—');
  });
});

describe('model provider manifests match spec.model', () => {
  const options = modelSchema.options;

  it.each(modelProviders.map((p) => [p.id, p] as const))('%s', (id, manifest) => {
    const option = options.find((o) => o.shape.provider.value === id);
    expect(option, id).toBeDefined();
    const schemaKeys = Object.keys(option?.shape ?? {})
      .filter((k) => k !== 'provider' && k !== 'name')
      .sort();
    const manifestKeys = [
      ...manifest.configFields.map((f) => f.key),
      ...manifest.secrets.map((s) => s.key),
    ].sort();
    expect(manifestKeys).toEqual(schemaKeys);
    expect(getModelProvider(id)).toBe(manifest);
  });
});
