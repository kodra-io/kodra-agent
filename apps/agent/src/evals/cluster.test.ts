import type { V1Pod } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { podMatches } from './cluster.ts';

const pod = (status: NonNullable<V1Pod['status']>, app = 'api'): V1Pod => ({
  metadata: { labels: { app } },
  status,
});
const container = (s: object) => ({
  name: 'c',
  image: 'i',
  imageID: '',
  ready: false,
  restartCount: 0,
  ...s,
});

describe('podMatches (L3)', () => {
  it('reads waiting and terminated reasons, current or last', () => {
    const pulling = pod({
      phase: 'Pending',
      containerStatuses: [container({ state: { waiting: { reason: 'ImagePullBackOff' } } })],
    });
    expect(podMatches(pulling, { state: 'waiting', reason: 'ImagePullBackOff|ErrImagePull' })).toBe(
      true,
    );
    expect(podMatches(pulling, { state: 'waiting', reason: 'CrashLoopBackOff' })).toBe(false);
    expect(podMatches(pulling, { state: 'pending' })).toBe(true);

    const oom = pod({
      phase: 'Running',
      containerStatuses: [
        container({
          restartCount: 2,
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
        }),
      ],
    });
    expect(podMatches(oom, { state: 'terminated', reason: 'OOMKilled' })).toBe(true);
    expect(podMatches(oom, { state: 'restarted' })).toBe(true);
    // A reason must match whole: "OOM" is not "OOMKilled".
    expect(podMatches(oom, { state: 'terminated', reason: 'OOM' })).toBe(false);
  });

  it('tells running, not ready, and pending apart, and filters by app', () => {
    const running = pod({
      phase: 'Running',
      containerStatuses: [container({ ready: true, state: { running: {} } })],
    });
    const notReady = pod({
      phase: 'Running',
      containerStatuses: [container({ ready: false, state: { running: {} } })],
    });
    expect(podMatches(running, { state: 'running' })).toBe(true);
    expect(podMatches(running, { state: 'not-ready' })).toBe(false);
    expect(podMatches(notReady, { state: 'not-ready' })).toBe(true);
    expect(podMatches(pod({ phase: 'Pending' }), { state: 'pending' })).toBe(true);
    expect(podMatches(pod({ phase: 'Pending' }), { state: 'running' })).toBe(false);
    expect(podMatches(running, { state: 'running', app: 'other' })).toBe(false);
  });
});
