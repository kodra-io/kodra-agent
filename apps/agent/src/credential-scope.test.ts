import { getConnector } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import type { Component } from './config.ts';
import { startupScopeProblem } from './credential-scope.ts';
import { fakeKubernetes } from './test-helpers.ts';

const manifest = getConnector('kubernetes');
if (!manifest) throw new Error('no kubernetes manifest');
const comp: Component = {
  id: 'kubernetes',
  displayName: 'Kubernetes',
  manifest,
  settings: { namespaces: ['api'] },
  secrets: [],
};
const admin = fakeKubernetes({ canI: (checks) => Promise.resolve(checks.map(() => true)) });

describe('credentials at startup (M29)', () => {
  it('refuses a broad kubeconfig, keeps one that is allowed, and starts a narrow one', async () => {
    expect(await startupScopeProblem(comp, { kubeconfig: 'kc' }, admin, 1000)).toEqual({
      refused:
        'its credential has more access than the agent needs: it is cluster-admin (it can do anything in the cluster)',
    });
    expect(
      await startupScopeProblem(
        { ...comp, allowBroadCredentials: true },
        { kubeconfig: 'kc' },
        admin,
        1000,
      ),
    ).toEqual({ kept: ['it is cluster-admin (it can do anything in the cluster)'] });
    expect(await startupScopeProblem(comp, { kubeconfig: 'kc' }, fakeKubernetes(), 1000)).toBe(
      null,
    );
  });

  it('starts the connector when the cluster does not answer in time', async () => {
    const slow = fakeKubernetes({ canI: () => new Promise<boolean[]>(() => undefined) });
    expect(await startupScopeProblem(comp, { kubeconfig: 'kc' }, slow, 20)).toBe(null);
  });
});
