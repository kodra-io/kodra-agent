import { describe, expect, it } from 'vitest';
import { fakeSelfKubernetes } from '../test-helpers.ts';
import {
  CONFIG_KEY,
  kubernetesBackend,
  PREVIOUS_KEY,
  RESTARTED_AT,
  selfNames,
} from './config-backend.ts';

const NAMES = { namespace: 'ops', configMap: 'agent', deployment: 'agent', secret: 'agent-env' };

describe('selfNames', () => {
  it('needs the namespace, ConfigMap, and Deployment; the Secret is optional', () => {
    expect(selfNames({})).toBeNull();
    expect(
      selfNames({
        KODRA_AGENT_NAMESPACE: 'ops',
        KODRA_AGENT_CONFIGMAP: 'agent',
        KODRA_AGENT_DEPLOYMENT: 'agent',
      }),
    ).toEqual({ namespace: 'ops', configMap: 'agent', deployment: 'agent', secret: null });
  });
});

describe('kubernetesBackend', () => {
  it('reads and saves the config in its own ConfigMap, keeping the previous one', async () => {
    const { client, state } = fakeSelfKubernetes('one');
    const backend = kubernetesBackend(client, NAMES);
    expect(await backend.read()).toBe('one');
    expect(await backend.readPrevious()).toBeNull();
    await backend.save('two', 'one');
    expect(state.configMap).toEqual({ [CONFIG_KEY]: 'two', [PREVIOUS_KEY]: 'one' });
    expect(await backend.readPrevious()).toBe('one');
    expect(state.calls.every((c) => c.includes('ops/agent'))).toBe(true);
  });

  it('sets and removes Secret keys, and restarts the Deployment', async () => {
    const { client, state } = fakeSelfKubernetes('one');
    state.secret['OLD'] = 'x';
    const backend = kubernetesBackend(client, NAMES);
    expect(backend.envWritable).toBe(true);
    await backend.writeEnv(new Map([['NEW', 'y']]), ['OLD']);
    expect(state.secret).toEqual({ NEW: 'y' });
    expect(state.calls).toContain('patch secret ops/agent-env');
    await backend.restart(new Date('2026-10-11T10:00:00.000Z'));
    expect(state.restartedAt).toEqual(['2026-10-11T10:00:00.000Z']);
    expect(RESTARTED_AT).toBe('kodra.io/restartedAt');
  });

  it('cannot write secrets without a Secret, and says when the config is missing', async () => {
    const { client, state } = fakeSelfKubernetes('one');
    const backend = kubernetesBackend(client, { ...NAMES, secret: null });
    expect(backend.envWritable).toBe(false);
    await expect(backend.writeEnv(new Map([['A', 'b']]), [])).rejects.toThrow('existingSecret');
    state.configMap = {};
    await expect(backend.read()).rejects.toThrow('has no kodra-agent.yaml');
  });
});
