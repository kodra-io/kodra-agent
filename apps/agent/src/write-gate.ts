/**
 * Blast-radius limits on writes (M29), across every conversation, alert, and channel: at most
 * `maxWritesPerHour` approved writes in any hour, and one change at a time per environment.
 * A change holds its environment from the approval request until it ran (or was denied), so
 * two changes to production are never waiting or running at once.
 */

const HOUR = 60 * 60 * 1000;
const DEFAULT_ENV = '(default)';

export type WriteSlot = { release: () => void; done: () => void } | { refused: string };

export class WriteGate {
  private readonly max: number;
  private readonly now: () => number;
  /** When each approved write ran, within the last hour. */
  private times: number[] = [];
  private readonly busy = new Set<string>();

  constructor(maxPerHour: number, now: () => number = Date.now) {
    this.max = maxPerHour;
    this.now = now;
  }

  /** Writes that already ran (from the audit log at startup), so a restart does not reset. */
  seed(times: readonly number[]): void {
    this.times.push(...times);
  }

  /** Takes the environment for one change, or says why it cannot start now. */
  begin(environment: string | null): WriteSlot {
    const now = this.now();
    this.times = this.times.filter((t) => now - t < HOUR).sort((a, b) => a - b);
    if (this.times.length >= this.max) {
      const free = new Date((this.times[0] ?? now) + HOUR);
      return {
        refused: `${String(this.times.length)} approved writes in the last hour is the most spec.limits.maxWritesPerHour allows; try again after ${free.toISOString().slice(11, 16)} UTC`,
      };
    }
    const key = environment ?? DEFAULT_ENV;
    if (this.busy.has(key)) {
      return {
        refused: `another change ${environment ? `to ${environment}` : 'here'} is waiting for approval or running; one at a time, so try again when it is done`,
      };
    }
    this.busy.add(key);
    let held = true;
    return {
      release: () => {
        if (held) this.busy.delete(key);
        held = false;
      },
      done: () => {
        this.times.push(this.now());
      },
    };
  }
}
