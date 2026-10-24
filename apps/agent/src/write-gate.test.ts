import { describe, expect, it } from 'vitest';
import { bigCut, numberAt } from './scale-limit.ts';
import { WriteGate } from './write-gate.ts';

describe('WriteGate (M29)', () => {
  it('allows one change at a time per environment', () => {
    const gate = new WriteGate(10, () => 0);
    const first = gate.begin('production');
    expect('release' in first).toBe(true);
    expect(gate.begin('production')).toEqual({
      refused:
        'another change to production is waiting for approval or running; one at a time, so try again when it is done',
    });
    // Another environment is not held up.
    expect('release' in gate.begin('staging')).toBe(true);
    if ('release' in first) first.release();
    expect('release' in gate.begin('production')).toBe(true);
  });

  it('refuses writes past the hourly limit until the hour has room, counting restarts', () => {
    let now = Date.parse('2026-10-24T10:00:00Z');
    const gate = new WriteGate(3, () => now);
    gate.seed([now - 50 * 60 * 1000]);
    for (let i = 0; i < 2; i++) {
      const slot = gate.begin(null);
      if (!('release' in slot)) throw new Error(slot.refused);
      slot.done();
      slot.release();
    }
    // A denied change takes its turn but does not count.
    const denied = gate.begin(null);
    if ('release' in denied) denied.release();
    expect(gate.begin(null)).toEqual({
      refused:
        '3 approved writes in the last hour is the most spec.limits.maxWritesPerHour allows; try again after 10:10 UTC',
    });
    now += 11 * 60 * 1000;
    expect('release' in gate.begin(null)).toBe(true);
  });
});

describe('scale limits (M29)', () => {
  const limit = {
    tool: 'resources_scale',
    replicasArg: 'scale',
    current: {
      tool: 'resources_get',
      copyArgs: ['namespace', 'name'],
      path: ['spec', 'replicas'],
    },
  };
  const object = (n: number) =>
    `apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: ${String(n)}\n`;

  it('treats scaling to zero, or by more than half, as a big cut', async () => {
    const read = (n: number | null) => () => Promise.resolve(n === null ? null : object(n));
    const args = (scale: number) => ({ namespace: 'api', name: 'web', scale });
    expect(await bigCut(limit, args(0), read(null))).toBe('scaling web to 0 stops it');
    expect(await bigCut(limit, args(1), read(4))).toBe(
      'scaling web from 4 to 1 cuts it by more than half',
    );
    expect(await bigCut(limit, args(2), read(4))).toBeNull();
    expect(await bigCut(limit, args(6), read(4))).toBeNull();
    // Not readable: only a cut to zero is caught.
    expect(await bigCut(limit, args(1), read(null))).toBeNull();
  });

  it('reads replicas from the object and passes only the copied arguments', async () => {
    const seen: unknown[] = [];
    await bigCut(limit, { namespace: 'api', name: 'web', scale: 1, extra: 'x' }, (a) => {
      seen.push(a);
      return Promise.resolve(null);
    });
    expect(seen).toEqual([{ namespace: 'api', name: 'web' }]);
    expect(numberAt(object(3), ['spec', 'replicas'])).toBe(3);
    expect(numberAt('not: [yaml', ['spec', 'replicas'])).toBeNull();
    expect(numberAt('spec: {}', ['spec', 'replicas'])).toBeNull();
  });
});
