import { manifestSchema, modelSchema, PLATFORMS, type Manifest } from '@kodra-agent/schema';
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

  it('has no tools without a server, and classifies tools when it has one', () => {
    for (const manifest of all) {
      if (manifest.runtime === null) expect(manifest.tools, manifest.id).toEqual({});
      else expect(Object.keys(manifest.tools).length, manifest.id).toBeGreaterThan(0);
    }
  });

  it('only guards tools it classifies, with settings it has', () => {
    for (const manifest of all) {
      const settings = manifest.configFields.map((f) => f.key);
      for (const [tool, guards] of Object.entries(manifest.guards ?? {})) {
        expect(manifest.tools[tool], `${manifest.id}.${tool}`).toBeDefined();
        for (const guard of guards)
          expect(settings, `${manifest.id}.${tool}`).toContain(guard.setting);
      }
    }
  });

  it('starts servers only with secrets and settings the manifest declares', () => {
    for (const manifest of all) {
      const runtime = manifest.runtime;
      if (runtime?.type !== 'mcp-stdio') continue;
      const secrets = manifest.secrets.map((s) => s.key);
      const settings = manifest.configFields.map((f) => f.key);
      const sources = [
        ...Object.values(runtime.env),
        ...runtime.args.filter((a) => typeof a !== 'string'),
        ...(runtime.secretArgs ?? []).flatMap((s) => s.args.filter((a) => typeof a !== 'string')),
      ];
      for (const s of runtime.secretArgs ?? []) expect(secrets, manifest.id).toContain(s.secret);
      for (const source of sources) {
        if ('secret' in source) expect(secrets, manifest.id).toContain(source.secret);
        if ('secretFile' in source) expect(secrets, manifest.id).toContain(source.secretFile);
        if ('setting' in source) expect(settings, manifest.id).toContain(source.setting);
      }
    }
  });

  it('never puts a secret value on a command line', () => {
    for (const manifest of all) {
      const runtime = manifest.runtime;
      if (runtime?.type !== 'mcp-stdio') continue;
      const argSources = [
        ...runtime.args,
        ...(runtime.secretArgs ?? []).flatMap((s) => s.args),
      ].filter((a) => typeof a !== 'string');
      expect(
        argSources.some((a) => 'secret' in a),
        manifest.id,
      ).toBe(false);
    }
  });

  it('pins binary servers for every supported platform', () => {
    for (const manifest of all) {
      const runtime = manifest.runtime;
      if (runtime?.type !== 'mcp-stdio' || runtime.source.kind !== 'github-release') continue;
      expect(Object.keys(runtime.source.assets).sort(), manifest.id).toEqual([...PLATFORMS].sort());
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
