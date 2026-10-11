import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeSelfKubernetes, tempDir } from '../test-helpers.ts';
import {
  BASE_KEY,
  CONFIG_KEY,
  configHash,
  kubernetesBackend,
  PREVIOUS_KEY,
  RESTARTED_AT,
  selfNames,
  startupConfig,
} from './config-backend.ts';

const NAMES = {
  namespace: 'ops',
  configMap: 'agent-settings',
  deployment: 'agent',
  secret: 'agent-env',
  settingsDir: '/etc/kodra-agent-settings',
};

describe('selfNames', () => {
  it('needs the namespace, ConfigMap, Deployment, and settings folder; the Secret is optional', () => {
    expect(selfNames({})).toBeNull();
    expect(
      selfNames({
        KODRA_AGENT_NAMESPACE: 'ops',
        KODRA_AGENT_CONFIGMAP: 'agent-settings',
        KODRA_AGENT_DEPLOYMENT: 'agent',
        KODRA_AGENT_SETTINGS_DIR: '/etc/kodra-agent-settings',
      }),
    ).toEqual({ ...NAMES, secret: null });
  });
});

describe('kubernetesBackend', () => {
  it('starts from the Helm config and saves the console copy with the hash it came from', async () => {
    const { client, state } = fakeSelfKubernetes();
    const backend = kubernetesBackend(client, NAMES, 'one');
    expect(await backend.read()).toBe('one');
    expect(await backend.readPrevious()).toBeNull();
    await backend.save('two', 'one');
    expect(state.configMap).toEqual({
      [CONFIG_KEY]: 'two',
      [PREVIOUS_KEY]: 'one',
      [BASE_KEY]: configHash('one'),
    });
    expect(await backend.read()).toBe('two');
    expect(await backend.readPrevious()).toBe('one');
    expect(state.calls.every((c) => c.includes('ops/agent-settings'))).toBe(true);

    // After a helm upgrade with another config, that config wins and Undo has nothing.
    const upgraded = kubernetesBackend(client, NAMES, 'three');
    expect(await upgraded.read()).toBe('three');
    expect(await upgraded.readPrevious()).toBeNull();
  });

  it('sets and removes Secret keys, and restarts the Deployment', async () => {
    const { client, state } = fakeSelfKubernetes();
    state.secret['OLD'] = 'x';
    const backend = kubernetesBackend(client, NAMES, 'one');
    expect(backend.envWritable).toBe(true);
    await backend.writeEnv(new Map([['NEW', 'y']]), ['OLD']);
    expect(state.secret).toEqual({ NEW: 'y' });
    expect(state.calls).toContain('patch secret ops/agent-env');
    await backend.restart(new Date('2026-10-11T10:00:00.000Z'));
    expect(state.restartedAt).toEqual(['2026-10-11T10:00:00.000Z']);
    expect(RESTARTED_AT).toBe('kodra.io/restartedAt');
  });

  it('cannot write secrets without a Secret', async () => {
    const { client } = fakeSelfKubernetes();
    const backend = kubernetesBackend(client, { ...NAMES, secret: null }, 'one');
    expect(backend.envWritable).toBe(false);
    await expect(backend.writeEnv(new Map([['A', 'b']]), [])).rejects.toThrow('existingSecret');
  });
});

describe('startupConfig', () => {
  it('uses the console copy only when it was made from the current Helm config', async () => {
    const dir = await tempDir();
    const basePath = join(dir, 'base.yaml');
    const settings = join(dir, 'settings');
    await mkdir(settings);
    await writeFile(basePath, 'one');
    expect(await startupConfig(basePath, settings)).toEqual({ path: basePath, setAside: false });

    await writeFile(join(settings, CONFIG_KEY), 'two');
    await writeFile(join(settings, BASE_KEY), configHash('one'));
    expect(await startupConfig(basePath, settings)).toEqual({
      path: join(settings, CONFIG_KEY),
      setAside: false,
    });

    await writeFile(basePath, 'three');
    expect(await startupConfig(basePath, settings)).toEqual({ path: basePath, setAside: true });
  });
});
