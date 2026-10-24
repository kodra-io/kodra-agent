import type { Manifest } from '@kodra-agent/schema';
import { numberAt } from './scale-limit.ts';

export type RolloutCheck = NonNullable<Manifest['rolloutCheck']>;

/** How often the object is read, and for how long (tests make both short). */
export interface RolloutTiming {
  intervalMs: number;
  timeoutMs?: number;
}

export const ROLLOUT_TIMING: RolloutTiming = { intervalMs: 15_000 };

export type RolloutOutcome =
  { settled: true; ready: number; want: number } | { settled: false; why: string };

/** The arguments of the read that shows the object: those `copyArgs` names, from the change. */
export function readArgs(
  check: RolloutCheck,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    check.read.copyArgs.flatMap((k) => (args[k] === undefined ? [] : [[k, args[k]]])),
  );
}

/**
 * Watches an object after an approved change (M29b) until it is ready (`have` reaches
 * `want`), or the time is up. Never throws: a read that fails is tried again.
 */
export async function watchRollout(
  check: RolloutCheck,
  read: () => Promise<string | null>,
  timing: RolloutTiming = ROLLOUT_TIMING,
  // Unref'd: a watch never keeps the agent from exiting (a restart to apply settings).
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => {
      setTimeout(r, ms).unref();
    }),
): Promise<RolloutOutcome> {
  const timeoutMs = timing.timeoutMs ?? check.timeoutSeconds * 1000;
  const deadline = Date.now() + timeoutMs;
  let last: { have: number; want: number } | null = null;
  for (;;) {
    const text = await read().catch(() => null);
    const want = numberAt(text, check.want);
    if (want !== null) {
      // Kubernetes leaves readyReplicas out while none are ready.
      const have = numberAt(text, check.have) ?? 0;
      if (have >= want) return { settled: true, ready: have, want };
      last = { have, want };
    }
    if (Date.now() + timing.intervalMs > deadline) break;
    await sleep(timing.intervalMs);
  }
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return {
    settled: false,
    why: last
      ? `${String(last.have)} of ${String(last.want)} ready after ${String(minutes)} minute${minutes === 1 ? '' : 's'}`
      : 'its state could not be read',
  };
}

/** The change that puts the object back, or null when the value before it is unknown. */
export function rollbackArgs(
  check: RolloutCheck,
  args: Readonly<Record<string, unknown>>,
  before: number | null,
): Record<string, unknown> | null {
  if (before === null || args[check.rollbackArg] === before) return null;
  return { ...args, [check.rollbackArg]: before };
}
