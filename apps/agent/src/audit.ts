import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Redactor } from './redactor.ts';

/** One record per event (SPEC section 8). Never a secret value: records are redacted. */
export const auditRecordSchema = z.strictObject({
  /** The hash chain (M14): this record's number, and the SHA-256 of the line before it. */
  seq: z.int().positive().optional(),
  prev: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  ts: z.iso.datetime(),
  event: z.enum([
    'task.start',
    'model.call',
    'tool.call',
    'approval.request',
    'approval.decision',
    /** One approver's approval, when a change needs more than one (detail: "1 of 2"). */
    'approval.vote',
    /** An approved change that overrode a freeze window (detail: the freeze and the reason). */
    'override',
    'result',
    'error',
    /** The agent paused or resumed by a person (detail says which). */
    'control',
    /** Settings changed from the console (detail says what; never a secret's value). */
    'settings',
  ]),
  actor: z.string().min(1),
  task: z.string().optional(),
  connector: z.string().optional(),
  tool: z.string().optional(),
  risk: z.enum(['read', 'write', 'destructive', 'unclassified']).optional(),
  decision: z.enum(['allowed', 'approved', 'denied', 'blocked', 'expired']).optional(),
  detail: z.string().max(4000).optional(),
  /** approval.decision records: the change reference the approver gave, where one was required. */
  changeRef: z.string().max(100).optional(),
  /** model.call records: tokens used, for the console's usage view. */
  usage: z
    .strictObject({
      input: z.int().nonnegative(),
      cacheRead: z.int().nonnegative(),
      cacheWrite: z.int().nonnegative(),
      output: z.int().nonnegative(),
    })
    .optional(),
  /** Customer values masked in this record, counted by type (M13); never the values. */
  redactions: z.record(z.string(), z.int().nonnegative()).optional(),
  /** The model, for model.call records (provider/name). */
  model: z.string().max(200).optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditInput = Omit<AuditRecord, 'ts' | 'seq' | 'prev'>;

export interface AuditOptions {
  /** Rotate when the file would grow past this many bytes. */
  maxBytes?: number;
  /** Rotated files to keep (audit.jsonl.1 … .N). */
  keep?: number;
  now?: () => Date;
  /** Called with each written line, already redacted (spec.audit.stdout, M14). */
  onRecord?: (line: string) => void;
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
  private readonly onRecord: ((line: string) => void) | undefined;

  constructor(path: string, redactor: Redactor, opts: AuditOptions = {}) {
    this.path = path;
    this.redactor = redactor;
    this.onRecord = opts.onRecord;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = opts.keep ?? 5;
    this.now = opts.now ?? (() => new Date());
  }

  append(input: AuditInput): Promise<void> {
    const parsed = auditRecordSchema.safeParse({ ts: this.now().toISOString(), ...input });
    if (!parsed.success) return Promise.reject(new Error('invalid audit record'));
    const record = parsed.data;
    // Redact the serialized line, so a secret in any field is masked.
    const { text, counts } = this.redactor.redactCounted(JSON.stringify(record));
    const body = {
      ...(JSON.parse(text) as object),
      ...(Object.keys(counts).length > 0 ? { redactions: counts } : {}),
    };
    const next = this.queue.then(() => this.write(body));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Chains the record to the last line on disk (M14): `seq` one more, `prev` its SHA-256. The
   * tail is read on every write, so another process writing the same log (doctor while the
   * agent runs) never breaks the chain.
   */
  private async write(body: object): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const last = (await lastLine(this.path)) ?? (await lastLine(`${this.path}.1`));
    const lastSeq = last ? (seqOf(last) ?? 0) : 0;
    const chained = JSON.stringify({
      seq: lastSeq + 1,
      prev: sha256(last ?? ''),
      ...body,
    });
    const line = `${chained}\n`;
    await this.rotateIfNeeded(Buffer.byteLength(line));
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.appendFile(line, 'utf8');
    } finally {
      await handle.close();
    }
    await chmod(this.path, 0o600);
    this.onRecord?.(chained);
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

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function seqOf(line: string): number | null {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === 'number' ? seq : null;
  } catch {
    return null;
  }
}

/** The last non-empty line of a file, or null when it is missing or empty. */
async function lastLine(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    // Records stay under 8 KB (details are clipped), so the tail always holds the last one.
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const lines = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    return lines.at(-1) ?? null;
  } finally {
    await handle.close();
  }
}

export interface ChainCheck {
  ok: boolean;
  /** Chained records checked. */
  records: number;
  /** Lines from before the chain (older agents), not covered by it. */
  unchained: number;
  /** The newest record: anyone who noted it can later check nothing before it changed. */
  head: { seq: number; hash: string } | null;
  /** The first break, in words. */
  problem: string | null;
}

/**
 * Checks the hash chain across the rotated files and the current one, oldest first. The first
 * kept record anchors the chain (older files were rotated away); every later one must follow
 * the line before it exactly, so editing, deleting, or reordering a record breaks it.
 */
export async function verifyAuditChain(path: string, keep = 5): Promise<ChainCheck> {
  const files = [...Array.from({ length: keep }, (_, i) => `${path}.${String(keep - i)}`), path];
  let previous: string | null = null;
  let previousSeq: number | null = null;
  let records = 0;
  let unchained = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const seq = seqOf(line);
      let prev: unknown;
      try {
        prev = (JSON.parse(line) as { prev?: unknown }).prev;
      } catch {
        prev = undefined;
      }
      if (seq === null) {
        if (previousSeq !== null) {
          return {
            ok: false,
            records,
            unchained,
            head: null,
            problem: `a record after ${String(previousSeq)} has no sequence number (inserted or edited)`,
          };
        }
        unchained++;
        previous = line;
        continue;
      }
      if (previousSeq !== null && seq !== previousSeq + 1) {
        return {
          ok: false,
          records,
          unchained,
          head: null,
          problem: `record ${String(seq)} follows ${String(previousSeq)}: records were deleted or reordered`,
        };
      }
      if (previous !== null && prev !== sha256(previous)) {
        return {
          ok: false,
          records,
          unchained,
          head: null,
          problem: `record ${String(seq)} does not match the record before it: one of them was edited`,
        };
      }
      records++;
      previous = line;
      previousSeq = seq;
    }
  }
  return {
    ok: true,
    records,
    unchained,
    head:
      previous !== null && previousSeq !== null
        ? { seq: previousSeq, hash: sha256(previous) }
        : null,
    problem: null,
  };
}

/** The newest record's number and hash, from the last line only (for the console's Overview). */
export async function auditHead(path: string): Promise<{ seq: number; hash: string } | null> {
  const last = (await lastLine(path)) ?? (await lastLine(`${path}.1`));
  const seq = last ? seqOf(last) : null;
  return last && seq !== null ? { seq, hash: sha256(last) } : null;
}
