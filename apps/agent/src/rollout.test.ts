import { describe, expect, it } from 'vitest';
import { readArgs, rollbackArgs, watchRollout, type RolloutCheck } from './rollout.ts';

const check: RolloutCheck = {
  tool: 'resources_scale',
  read: { tool: 'resources_get', copyArgs: ['namespace', 'name'] },
  want: ['spec', 'replicas'],
  have: ['status', 'readyReplicas'],
  rollbackArg: 'scale',
  timeoutSeconds: 300,
};
const object = (want: number, ready?: number) =>
  `spec:\n  replicas: ${String(want)}\nstatus:\n${ready === undefined ? '  {}' : `  readyReplicas: ${String(ready)}`}\n`;
const quick = { intervalMs: 1, timeoutMs: 50 };

describe('rollout checks (M29b)', () => {
  it('settles once the ready replicas reach the desired ones', async () => {
    const states = [object(3), object(3, 1), object(3, 3)];
    const outcome = await watchRollout(check, () => Promise.resolve(states.shift() ?? null), quick);
    expect(outcome).toEqual({ settled: true, ready: 3, want: 3 });
  });

  it('says how far it got when the time is up, or that it could not read the object', async () => {
    expect(await watchRollout(check, () => Promise.resolve(object(3, 1)), quick)).toEqual({
      settled: false,
      why: '1 of 3 ready after 1 minute',
    });
    expect(await watchRollout(check, () => Promise.reject(new Error('down')), quick)).toEqual({
      settled: false,
      why: 'its state could not be read',
    });
  });

  it('names the change that puts it back, and reads with the copied arguments only', () => {
    const args = { namespace: 'api', name: 'web', scale: 1 };
    expect(rollbackArgs(check, args, 4)).toEqual({ namespace: 'api', name: 'web', scale: 4 });
    expect(rollbackArgs(check, args, null)).toBeNull();
    expect(rollbackArgs(check, args, 1)).toBeNull();
    expect(readArgs(check, { ...args, extra: true })).toEqual({ namespace: 'api', name: 'web' });
  });
});
