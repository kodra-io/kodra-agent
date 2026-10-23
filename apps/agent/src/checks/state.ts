import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writePrivateFile } from '../env-file.ts';
import type { CheckGap, CheckId, Finding } from './rules.ts';

/** One run's result: what is broken, split by whether it was there last time. */
export interface Digest {
  at: string;
  /** A schedule's name, or who asked for it. */
  trigger: string;
  fresh: (Finding & { since: string })[];
  ongoing: (Finding & { since: string })[];
  /** Broken last time, fine now. */
  resolved: Finding[];
  gaps: CheckGap[];
  ran: CheckId[];
  /** Checks with nothing to look at (their connector is off or has no targets). */
  skipped: CheckId[];
  /** The audit chain head when the digest was made. */
  auditHead: { seq: number; hash: string } | null;
}

interface Stored {
  /** Last local date each schedule ran. */
  schedules: Record<string, string>;
  /** Open findings and when each was first seen. */
  open: Record<string, Finding & { since: string }>;
  latest: Digest | null;
}

const EMPTY: Stored = { schedules: {}, open: {}, latest: null };

/**
 * checks.json next to the audit log: open findings, the last run of each schedule, and the
 * latest digest, so a restart neither repeats a run nor calls everything new.
 */
export class ChecksState {
  private readonly path: string;
  private data: Stored = structuredClone(EMPTY);

  constructor(auditPath: string) {
    this.path = join(dirname(auditPath), 'checks.json');
  }

  /** A missing or unreadable file starts empty. */
  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8').catch(() => null);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Partial<Stored>;
      this.data = {
        schedules: parsed.schedules ?? {},
        open: parsed.open ?? {},
        latest: parsed.latest ?? null,
      };
    } catch {
      this.data = structuredClone(EMPTY);
    }
  }

  async save(): Promise<void> {
    await writePrivateFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  lastRun(schedule: string): string | null {
    return this.data.schedules[schedule] ?? null;
  }

  markRun(schedule: string, date: string): void {
    this.data.schedules[schedule] = date;
  }

  get latest(): Digest | null {
    return this.data.latest;
  }

  /**
   * Compares this run's findings with the open ones. A finding from a check that could not
   * run this time (its card failed) stays open rather than being called resolved.
   */
  diff(
    findings: readonly Finding[],
    run: Omit<Digest, 'fresh' | 'ongoing' | 'resolved'>,
    commit: boolean,
  ): Digest {
    const fresh: Digest['fresh'] = [];
    const ongoing: Digest['ongoing'] = [];
    const open: Stored['open'] = {};
    for (const f of findings) {
      if (open[f.id]) continue;
      const before = this.data.open[f.id];
      const item = { ...f, since: before?.since ?? run.at };
      open[f.id] = item;
      (before ? ongoing : fresh).push(item);
    }
    const unchecked = (f: Finding) =>
      !run.ran.includes(f.check) ||
      run.gaps.some((g) => g.check === f.check && g.where === f.where);
    const resolved: Finding[] = [];
    for (const [id, before] of Object.entries(this.data.open)) {
      if (open[id]) continue;
      if (unchecked(before)) {
        open[id] = before;
        continue;
      }
      const finding: Finding & { since?: string } = { ...before };
      delete finding.since;
      resolved.push(finding);
    }
    const digest: Digest = { ...run, fresh, ongoing, resolved };
    if (commit) {
      this.data.open = open;
      this.data.latest = digest;
    }
    return digest;
  }
}
