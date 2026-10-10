import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Redactor } from './redactor.ts';

/** One record per event (SPEC section 8). Never a secret value: records are redacted. */
export const auditRecordSchema = z.strictObject({
  ts: z.iso.datetime(),
  event: z.enum([
    'task.start',
    'model.call',
    'tool.call',
    'approval.request',
    'approval.decision',
    'result',
    'error',
    /** The agent paused or resumed by a person (detail says which). */
    'control',
  ]),
  actor: z.string().min(1),
  task: z.string().optional(),
  connector: z.string().optional(),
  tool: z.string().optional(),
  risk: z.enum(['read', 'write', 'destructive', 'unclassified']).optional(),
  decision: z.enum(['allowed', 'approved', 'denied', 'blocked', 'expired']).optional(),
  detail: z.string().max(4000).optional(),
  /** model.call records: tokens used, for the console's usage view. */
  usage: z
    .strictObject({
      input: z.int().nonnegative(),
      cacheRead: z.int().nonnegative(),
      cacheWrite: z.int().nonnegative(),
      output: z.int().nonnegative(),
    })
    .optional(),
  /** The model, for model.call records (provider/name). */
  model: z.string().max(200).optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditInput = Omit<AuditRecord, 'ts'>;

export interface AuditOptions {
  /** Rotate when the file would grow past this many bytes. */
  maxBytes?: number;
  /** Rotated files to keep (audit.jsonl.1 … .N). */
  keep?: number;
  now?: () => Date;
}

/**
 * Append-only JSONL audit log with owner-only permissions, rotated by size. Writes are
 * queued so concurrent events keep their order.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;
  readonly path: string;
  private readonly redactor: Redactor;

  constructor(path: string, redactor: Redactor, opts: AuditOptions = {}) {
    this.path = path;
    this.redactor = redactor;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 5;
    this.now = opts.now ?? (() => new Date());
  }

  append(input: AuditInput): Promise<void> {
    const parsed = auditRecordSchema.safeParse({ ts: this.now().toISOString(), ...input });
    if (!parsed.success) return Promise.reject(new Error('invalid audit record'));
    const record = parsed.data;
    // Redact the serialized line, so a secret in any field is masked.
    const line = `${this.redactor.redact(JSON.stringify(record))}\n`;
    const next = this.queue.then(() => this.write(line));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded(Buffer.byteLength(line));
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.appendFile(line, 'utf8');
    } finally {
      await handle.close();
    }
    await chmod(this.path, 0o600);
  }

  private async rotateIfNeeded(incoming: number): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (size === 0 || size + incoming <= this.maxBytes) return;
    await rm(`${this.path}.${String(this.keep)}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        await rename(`${this.path}.${String(i)}`, `${this.path}.${String(i + 1)}`);
      } catch {
        // That generation does not exist yet.
      }
    }
    await rename(this.path, `${this.path}.1`);
  }
}
