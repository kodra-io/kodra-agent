import {
  allVariants,
  httpRuntime,
  isUsable,
  manifestSchema,
  modelSchema,
  resolveVariant,
  PLATFORMS,
  stdioRuntimes,
  type Manifest,
} from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { connectors, getConnector, getModelProvider, modelProviders } from './index.ts';

const all: readonly Manifest[] = [...connectors, ...modelProviders];
/** Each manifest once per server it can use (B4): the default, then each variant. */
const servers: readonly Manifest[] = all.flatMap(allVariants);

describe('connector registry', () => {
  it('lists the MVP catalog from SPEC section 6', () => {
    const ids = (status: string) => connectors.filter((c) => c.status === status).map((c) => c.id);
    // Launch plan L1, then B3: Docker, Jenkins, and Databases left preview. B4: cloud
    // providers (AWS) are coming soon, as a licensed add-on later.
    expect(ids('available').sort()).toEqual(
      [
        'databases',
        'docker',
        'jenkins',
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
    expect(ids('preview')).toEqual([]);
    const comingSoon = ids('coming-soon');
    expect(comingSoon.sort()).toEqual(
      ['aws', 'azure', 'azure-devops', 'bitbucket', 'gcp', 'teams'].sort(),
    );
    expect(modelProviders.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'azure-openai',
      'bedrock',
      'ollama',
    ]);
    expect(modelProviders.every((p) => p.status === 'available')).toBe(true);
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
    for (const manifest of servers) {
      if (manifest.runtime === null) expect(manifest.tools, manifest.id).toEqual({});
      else expect(Object.keys(manifest.tools).length, manifest.id).toBeGreaterThan(0);
    }
  });

  it('only guards tools it classifies, with settings it has', () => {
    for (const manifest of servers) {
      const settings = manifest.configFields.map((f) => f.key);
      for (const [tool, guards] of Object.entries(manifest.guards ?? {})) {
        expect(manifest.tools[tool], `${manifest.id}.${tool}`).toBeDefined();
        for (const guard of guards) {
          if (guard.kind === 'repo-in-setting' && guard.from) {
            // A shared setting must come from a connector this one requires.
            const required = manifest.requires.flatMap((r) =>
              r.anyOf.flatMap((alt) => ('connector' in alt ? [alt.connector] : [])),
            );
            expect(required, `${manifest.id}.${tool}`).toContain(guard.from);
            expect(
              getConnector(guard.from)?.configFields.map((f) => f.key),
              `${manifest.id}.${tool}`,
            ).toContain(guard.setting);
          } else if ('setting' in guard) {
            expect(settings, `${manifest.id}.${tool}`).toContain(guard.setting);
          }
          if (guard.kind === 'not-default-branch') {
            expect(manifest.defaultBranchLookup, `${manifest.id}.${tool}`).toBeDefined();
          }
        }
      }
    }
  });

  it('starts servers only with secrets and settings the manifest declares', () => {
    for (const manifest of servers) {
      const secrets = manifest.secrets.map((s) => s.key);
      const settings = manifest.configFields.map((f) => f.key);
      const required = manifest.requires.flatMap((r) =>
        r.anyOf.flatMap((alt) => ('connector' in alt ? [alt.connector] : [])),
      );
      for (const runtime of stdioRuntimes(manifest)) {
        const sources = [
          ...Object.values(runtime.env),
          ...runtime.args.filter((a) => typeof a !== 'string'),
          ...(runtime.secretArgs ?? []).flatMap((s) => s.args.filter((a) => typeof a !== 'string')),
        ];
        for (const s of runtime.secretArgs ?? []) expect(secrets, manifest.id).toContain(s.secret);
        for (const source of sources) {
          if ('secret' in source && source.from !== undefined) {
            // A shared secret must come from a connector this one requires.
            expect(required, manifest.id).toContain(source.from);
            expect(
              getConnector(source.from)?.secrets.map((x) => x.key),
              manifest.id,
            ).toContain(source.secret);
          } else if ('secret' in source) {
            expect(secrets, manifest.id).toContain(source.secret);
          }
          if ('secretFile' in source) expect(secrets, manifest.id).toContain(source.secretFile);
          if ('setting' in source && source.from !== undefined) {
            expect(required, manifest.id).toContain(source.from);
            expect(
              getConnector(source.from)?.configFields.map((f) => f.key),
              manifest.id,
            ).toContain(source.setting);
          } else if ('setting' in source) {
            expect(settings, manifest.id).toContain(source.setting);
          }
        }
      }
    }
  });

  it('never puts a secret value on a command line', () => {
    for (const manifest of servers) {
      for (const runtime of stdioRuntimes(manifest)) {
        const argSources = [
          ...runtime.args,
          ...(runtime.secretArgs ?? []).flatMap((s) => s.args),
        ].filter((a) => typeof a !== 'string');
        expect(
          argSources.some((a) => 'secret' in a),
          manifest.id,
        ).toBe(false);
      }
    }
  });

  it('pins binary servers for every supported platform and names multiple servers', () => {
    for (const manifest of servers) {
      const runtimes = stdioRuntimes(manifest);
      if (runtimes.length > 1) {
        const names = runtimes.map((r) => r.name);
        expect(names.every(Boolean), manifest.id).toBe(true);
        expect(new Set(names).size, manifest.id).toBe(names.length);
      }
      for (const runtime of runtimes) {
        if (runtime.source.kind !== 'github-release') continue;
        expect(Object.keys(runtime.source.assets).sort(), manifest.id).toEqual(
          [...PLATFORMS].sort(),
        );
      }
    }
  });

  it('gates servers only on list settings that exist and accept the value', () => {
    for (const manifest of servers) {
      for (const runtime of stdioRuntimes(manifest)) {
        if (!runtime.onlyIf) continue;
        const { setting, includes } = runtime.onlyIf;
        const field = manifest.configFields.find((f) => f.key === setting);
        expect(field?.kind, `${manifest.id}: ${setting}`).toBe('string-list');
        if (field?.kind === 'string-list' && field.pattern) {
          expect(new RegExp(field.pattern).test(includes), `${manifest.id}: ${includes}`).toBe(
            true,
          );
        }
        if (field?.kind === 'string-list') expect(field.default ?? []).toContain(includes);
      }
    }
  });

  it('turns off the GitLab server update check (no outbound call nobody asked for)', () => {
    for (const id of ['gitlab', 'gitlab-ci']) {
      const manifest = getConnector(id);
      if (!manifest) throw new Error(`no ${id} connector`);
      for (const runtime of allVariants(manifest).flatMap(stdioRuntimes)) {
        expect(runtime.env['GITLAB_DISABLE_VERSION_CHECK'], id).toEqual({ value: 'true' });
      }
    }
  });

  it('sends remote servers only declared settings and secrets, in headers, over the url setting', () => {
    for (const manifest of servers) {
      const runtime = httpRuntime(manifest);
      if (!runtime) continue;
      const owner = (from: string | undefined) => (from ? getConnector(from) : manifest);
      const fields = (from: string | undefined) => owner(from)?.configFields ?? [];
      expect(
        fields(runtime.url.from).find((f) => f.key === runtime.url.setting)?.kind,
        manifest.id,
      ).toBe('url');
      for (const value of Object.values(runtime.headers)) {
        const sources =
          'bearer' in value
            ? [value.bearer]
            : 'basic' in value
              ? [value.basic.user, value.basic.password]
              : [value];
        for (const source of sources) {
          if ('secret' in source) {
            expect(
              owner(source.from)?.secrets.map((x) => x.key),
              manifest.id,
            ).toContain(source.secret);
          }
          if ('setting' in source) {
            expect(
              fields(source.from).map((f) => f.key),
              manifest.id,
            ).toContain(source.setting);
          }
        }
      }
    }
  });

  it('offers the official server by default and the community one as a fallback (B4)', () => {
    for (const id of ['gitlab', 'gitlab-ci', 'jenkins']) {
      const manifest = getConnector(id);
      if (!manifest) throw new Error(id);
      expect(httpRuntime(manifest), id).not.toBeNull();
      const [, community, ...rest] = allVariants(manifest);
      expect(rest, id).toEqual([]);
      expect(community && stdioRuntimes(community).length, id).toBe(1);
      expect(community?.variants, id).toBeUndefined();
    }
  });

  it('has copy in English only', () => {
    expect(JSON.stringify(all)).not.toMatch(/[؀-ۿ]/);
  });

  it('uses no em dashes in copy', () => {
    expect(JSON.stringify(all)).not.toContain('—');
  });

  // M28: the console shows how to get every secret, so nobody edits files by hand.
  it('says how to get every secret, with a command for each system wherever there is one', () => {
    const missing: string[] = [];
    for (const m of all.filter(isUsable)) {
      for (const s of m.secrets) if (!s.steps?.length) missing.push(`${m.id}.${s.key}`);
      for (const f of m.configFields) {
        if (f.kind !== 'entries') continue;
        for (const x of f.fields) {
          if (x.kind === 'secret' && !x.steps?.length) missing.push(`${m.id}.${f.key}.${x.key}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // File secrets are made with commands, and say which file to upload.
    const files = all.flatMap((m) => [
      ...m.secrets.filter((s) => s.format),
      ...m.configFields.flatMap((f) =>
        f.kind === 'entries' ? f.fields.filter((x) => x.kind === 'secret' && x.format) : [],
      ),
    ]);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const steps = 'steps' in f ? (f.steps ?? []) : [];
      expect(steps.some((s) => s.run)).toBe(true);
      expect(steps.at(-1)?.text).toMatch(/^Upload /);
    }
    // The bastion's fingerprint comes with the commands to read it.
    const databases = getConnector('databases');
    const entries = databases?.configFields.find((f) => f.kind === 'entries');
    const hostKey =
      entries?.kind === 'entries' ? entries.fields.find((x) => x.key === 'tunnelHostKey') : null;
    expect(hostKey && 'steps' in hostKey ? hostKey.steps?.length : 0).toBeGreaterThan(0);
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

describe('server variants (B4)', () => {
  const jenkins = getConnector('jenkins');
  const ci = getConnector('gitlab-ci');
  const variants = jenkins?.variants;
  const community = variants?.options['community'];
  if (!jenkins || !variants || !community || !ci)
    throw new Error('jenkins and gitlab-ci have variants');
  const issues = (manifest: Manifest) =>
    (manifestSchema.safeParse(manifest).error?.issues ?? []).map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
  const withServerField = (patch: Record<string, unknown>): Manifest => ({
    ...jenkins,
    configFields: jenkins.configFields.map((f) => (f.key === 'server' ? { ...f, ...patch } : f)),
  });

  it('needs a string setting with a default that picks the default server', () => {
    expect(issues({ ...jenkins, variants: { ...variants, setting: 'nope' } })).toEqual([
      'variants.setting: nope must be a string setting with a default and a pattern that allows community',
    ]);
    // The default must not itself be a variant, or the default server could never run.
    expect(issues(withServerField({ default: 'community' }))).toHaveLength(1);
    // Every option must be a value the setting accepts.
    expect(issues(withServerField({ pattern: '^plugin$' }))).toHaveLength(1);
  });

  it("reads another connector's setting only from a connector it requires", () => {
    expect(issues({ ...ci, requires: [] })).toContain(
      'variants.from: gitlab is not a connector this manifest requires',
    );
  });

  it('checks each variant like the default server', () => {
    const panel = community.dashboard?.[0];
    if (!panel) throw new Error('the community server has a dashboard');
    const broken: Manifest = {
      ...jenkins,
      variants: {
        ...variants,
        options: {
          community: {
            ...community,
            dashboard: [{ ...panel, tool: 'stop_build' }],
          },
        },
      },
    };
    expect(issues(broken)).toEqual([
      'variants.options.community.dashboard.0.tool: stop_build is not a read tool of this connector',
    ]);
  });

  it('resolves to the default server for a missing or unknown value', () => {
    const plain = (settings: Record<string, unknown>) =>
      httpRuntime(resolveVariant(jenkins, settings));
    expect(plain({})).not.toBeNull();
    expect(plain({ server: 'plugin' })).not.toBeNull();
    expect(plain({ server: 'elsewhere' })).not.toBeNull();
    expect(plain({ server: 'community' })).toBeNull();
    // The resolved manifest has no variants left to pick from.
    expect(resolveVariant(jenkins, { server: 'community' }).variants).toBeUndefined();
  });
});
