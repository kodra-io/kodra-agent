import type { Manifest, McpStdioRuntime } from '@kodra-agent/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { Component } from '../config.ts';
import { jsonLogger } from '../io.ts';
import { Redactor } from '../redactor.ts';
import { fakeLauncher, fakeManifest } from '../test-fixtures/fake-connector.ts';
import { ConnectorHost, type ConnectorInput } from './host.ts';

let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

const baseRuntime = (): McpStdioRuntime => {
  const runtime = fakeManifest.runtime;
  if (!runtime || Array.isArray(runtime) || runtime.type !== 'mcp-stdio')
    throw new Error('fixture');
  return {
    ...runtime,
    args: [],
    secretArgs: [],
    configFile: undefined,
    accessArgs: {},
    env: {},
  };
};

function component(
  manifest: Manifest,
  settings: Record<string, unknown> = { namespaces: ['api'] },
): Component {
  return { id: manifest.id, displayName: manifest.displayName, manifest, settings, secrets: [] };
}

async function start(inputs: ConnectorInput[]) {
  const redactor = new Redactor();
  host = await ConnectorHost.start(inputs, {
    redactor,
    log: jsonLogger(() => undefined, redactor),
    launcher: fakeLauncher(),
    env: {},
  });
  return host;
}

async function whoami(h: ConnectorHost, name: string) {
  return JSON.parse((await h.call(name, {})).text) as {
    fakeToken: string | null;
    fakeUrl: string | null;
  };
}

describe('shared secrets and settings', () => {
  const child = (requires: Manifest['requires']): Manifest => ({
    ...fakeManifest,
    id: 'child',
    requires,
    runtime: {
      ...baseRuntime(),
      env: {
        FAKE_TOKEN: { secret: 'token', from: 'fakek8s' },
        FAKE_URL: { setting: 'url', suffix: '/api/v4', from: 'fakek8s' },
      },
    },
  });
  const shared = {
    sharedSecrets: { fakek8s: { token: 'parent-token-123' } },
    sharedSettings: { fakek8s: { url: 'https://git.example/', namespaces: ['api'] } },
  };

  it('passes a required connector’s secret and setting, with the suffix', async () => {
    const requires: Manifest['requires'] = [
      { anyOf: [{ connector: 'fakek8s' }], message: { en: 'x', ar: 'x' } },
    ];
    const h = await start([
      { component: component(child(requires)), access: 'read-only', secrets: {}, ...shared },
    ]);
    expect(await whoami(h, 'child__whoami')).toMatchObject({
      fakeToken: 'parent-token-123',
      fakeUrl: 'https://git.example/api/v4',
    });
  });

  it('refuses to share with a connector that does not require it', async () => {
    const h = await start([
      { component: component(child([])), access: 'read-only', secrets: {}, ...shared },
    ]);
    expect(await whoami(h, 'child__whoami')).toMatchObject({ fakeToken: null, fakeUrl: null });
  });
});

describe('several servers per connector', () => {
  it('starts each server and routes tools to the one that offers them', async () => {
    const multi: Manifest = {
      ...fakeManifest,
      id: 'multi',
      tools: { pods_log: 'read', resources_scale: 'write', wipe_everything: 'destructive' },
      hiddenTools: ['whoami'],
      guards: {},
      runtime: [
        { ...baseRuntime(), name: 'first' },
        { ...baseRuntime(), name: 'second' },
      ],
    };
    // Both fake servers offer the same tools, so the second must be refused.
    await expect(
      start([{ component: component(multi), access: 'read-only', secrets: {} }]),
    ).rejects.toThrow(
      /multi\/second offers pods_log, which another Fake Kubernetes server already offers/,
    );
  });

  it('routes each tool to the server that offers it', async () => {
    const multi: Manifest = {
      ...fakeManifest,
      id: 'multi',
      tools: { pods_log: 'read', whoami: 'read', resources_scale: 'write' },
      hiddenTools: ['wipe_everything', 'not_in_manifest'],
      guards: {},
      runtime: [
        { ...baseRuntime(), name: 'logs', args: ['--only', 'pods_log,whoami'] },
        { ...baseRuntime(), name: 'scaler', args: ['--only', 'resources_scale'] },
      ],
    };
    const h = await start([
      { component: component(multi), access: 'read-write-approved', secrets: {} },
    ]);
    const servers = Object.fromEntries(h.tools().map((t) => [t.tool, t.server]));
    expect(servers['pods_log']).toBe(servers['whoami']);
    expect(servers['resources_scale']).not.toBe(servers['pods_log']);
    expect(
      (await h.call('multi__resources_scale', { namespace: 'api', name: 'web', scale: 2 })).text,
    ).toBe('scaled api/web to 2');
    expect((await h.call('multi__pods_log', { namespace: 'api', name: 'x' })).text).toContain(
      'logs for api/x',
    );
  });

  it('hides tools listed in hiddenTools without auditing them as unclassified', async () => {
    const hidden: Manifest = {
      ...fakeManifest,
      id: 'hidden',
      tools: { pods_log: 'read' },
      hiddenTools: ['whoami', 'resources_scale', 'wipe_everything', 'not_in_manifest'],
      guards: {},
      runtime: baseRuntime(),
    };
    const h = await start([{ component: component(hidden), access: 'read-only', secrets: {} }]);
    expect(h.tools().map((t) => t.name)).toEqual(['hidden__pods_log']);
  });
});
