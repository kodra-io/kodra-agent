import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditLog } from './audit.ts';
import { writePrivateFile } from './env-file.ts';

/** Whether changes are paused, and by whom. Saved next to the audit log, so it survives a restart. */
export interface PauseState {
  by: string;
  at: string;
}

/**
 * The pause switch. While paused, every change is refused when it would run (even one
 * approved earlier); reads and chat keep working. Anyone signed in may pause; resuming is
 * for an approver (the console checks). Both are audited.
 */
export class AgentControl {
  private state: PauseState | null = null;
  private readonly path: string;
  private readonly audit: AuditLog;
  private readonly listeners = new Set<(state: PauseState | null, who: string) => void>();
  private readonly now: () => Date;

  constructor(auditPath: string, audit: AuditLog, now: () => Date = () => new Date()) {
    this.path = join(dirname(auditPath), 'control.json');
    this.audit = audit;
    this.now = now;
  }

  /** Reads the saved state. A missing or unreadable file means not paused. */
  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8').catch(() => null);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { paused?: unknown; by?: unknown; at?: unknown };
      if (
        parsed.paused === true &&
        typeof parsed.by === 'string' &&
        typeof parsed.at === 'string'
      ) {
        this.state = { by: parsed.by, at: parsed.at };
      }
    } catch {
      // A broken file is treated as not paused; the next change rewrites it.
    }
  }

  get paused(): PauseState | null {
    return this.state;
  }

  /** The reason a change is refused now, or null when changes may run. */
  readonly reason = (): string | null =>
    this.state
      ? `changes are paused (by ${this.state.by}); an approver can resume them in the console`
      : null;

  onChange(listener: (state: PauseState | null, who: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async pause(by: string): Promise<void> {
    if (this.state) return;
    this.state = { by, at: this.now().toISOString() };
    await this.save();
    await this.audit.append({ event: 'control', actor: by, detail: 'paused: changes are refused' });
    for (const l of this.listeners) l(this.state, by);
  }

  async resume(by: string): Promise<void> {
    if (!this.state) return;
    this.state = null;
    await this.save();
    await this.audit.append({ event: 'control', actor: by, detail: 'resumed: changes may run' });
    for (const l of this.listeners) l(null, by);
  }

  private async save(): Promise<void> {
    await writePrivateFile(
      this.path,
      `${JSON.stringify(this.state ? { paused: true, ...this.state } : { paused: false })}\n`,
    );
  }
}
