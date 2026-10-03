import { fileURLToPath } from 'node:url';
import { defineManifest, type Manifest, type McpStdioRuntime } from '@kodra-agent/schema';
import type { Component } from '../config.ts';
import type { Launch } from '../mcp/host.ts';

const t = (en: string) => ({ en, ar: en });
const SERVER = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url));

/** A connector manifest whose server is the fake MCP server above. */
export const fakeManifest: Manifest = defineManifest({
  id: 'fakek8s',
  displayName: 'Fake Kubernetes',
  category: 'deploy',
  status: 'available',
  description: t('fake'),
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    { kind: 'string-list', key: 'namespaces', required: true, description: t('ns') },
    { kind: 'url', key: 'url', required: false, description: t('url') },
  ],
  secrets: [
    {
      key: 'token',
      envVar: 'FAKE_TOKEN',
      defaultRef: 'env',
      required: false,
      description: t('token'),
      howToCreate: t('make one'),
      minimumScopes: {},
      probe: 'fakek8s.none',
    },
  ],
  tools: {
    pods_log: 'read',
    whoami: 'read',
    resources_scale: 'write',
    wipe_everything: 'destructive',
  },
  guards: {
    pods_log: [{ kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: true }],
    resources_scale: [
      { kind: 'arg-in-setting', arg: 'namespace', setting: 'namespaces', required: true },
    ],
  },
  runtime: {
    type: 'mcp-stdio',
    source: { kind: 'pypi', package: 'unused', version: '0.0.0', command: 'unused' },
    args: ['--fixed', { setting: 'namespaces' }],
    accessArgs: { 'read-only': ['--read-only'] },
    secretArgs: [{ secret: 'token', args: ['--token-file', { secretFile: 'token' }] }],
    env: { FAKE_TOKEN: { secret: 'token' }, FAKE_URL: { setting: 'url' } },
    inheritEnv: ['FAKE_INHERITED'],
    configFile: { arg: '--config', content: 'allowed = ["pods_log"]\n' },
  },
  permissionsSummary: { 'read-only': [t('reads')], 'read-write-approved': [t('writes')] },
});

/** Runs the fake server with Node's type stripping instead of a pinned binary. */
export function fakeLauncher(): (manifest: Manifest, runtime: McpStdioRuntime) => Launch {
  return () => ({
    command: process.execPath,
    args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SERVER],
  });
}

export function fakeComponent(
  settings: Record<string, unknown> = { namespaces: ['api'] },
): Component {
  return {
    id: fakeManifest.id,
    displayName: fakeManifest.displayName,
    manifest: fakeManifest,
    settings,
    secrets: [],
  };
}
