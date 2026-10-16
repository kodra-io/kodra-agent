import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writePrivateFile } from '../env-file.ts';
import { CONSOLE_ADMIN } from '@kodra-agent/schema';
import type { AuditLog } from '../audit.ts';

/**
 * The console's admin sign-in: `admin` with a password. Until a password is set, the
 * default `admin`/`admin` signs in, and the console allows nothing but setting a new one.
 * Only a scrypt hash is kept, in an owner-only file next to the audit log. Single-user for
 * now: user accounts and roles come later.
 */

export const ADMIN_USERNAME = 'admin';
/** The admin's name in approver lists and the audit log. */
export const ADMIN_USER = CONSOLE_ADMIN;
export const DEFAULT_ADMIN_PASSWORD = 'admin';
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;

function hash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

interface Stored {
  salt: Buffer;
  hash: Buffer;
}

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(next: string, current: string): string | null {
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  if (next.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`;
  }
  if (next === DEFAULT_ADMIN_PASSWORD || next === current) {
    return 'Choose a password different from the current one.';
  }
  return null;
}

export class AdminAccount {
  private readonly path: string;
  private readonly audit: AuditLog | undefined;
  private stored: Stored | null = null;
  /** Signs sessions while the default password is in use: new on every start. */
  private readonly defaultKey = randomBytes(32);

  constructor(opts: { path: string; audit?: AuditLog }) {
    this.path = opts.path;
    this.audit = opts.audit;
  }

  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8').catch(() => null);
    if (text === null) return;
    // A broken file must not fall back to admin/admin: refuse to start instead.
    const parsed = JSON.parse(text) as { admin?: { salt?: unknown; hash?: unknown } };
    const { salt, hash: stored } = parsed.admin ?? {};
    if (typeof salt !== 'string' || typeof stored !== 'string') {
      throw new Error(`${this.path} is not a console password file. Remove it to reset admin.`);
    }
    this.stored = { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(stored, 'base64') };
  }

  /** Whether the default password is still in use, so it must be changed first. */
  mustChange(): boolean {
    return this.stored === null;
  }

  /** The key that signs this account's sessions: changing the password ends them all. */
  sessionKey(): Buffer {
    return this.stored?.hash ?? this.defaultKey;
  }

  async verify(password: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    if (!this.stored) {
      // Hash anyway, so a wrong guess takes as long as with a set password.
      const given = await hash(password, this.defaultKey);
      const expected = await hash(DEFAULT_ADMIN_PASSWORD, this.defaultKey);
      return timingSafeEqual(given, expected);
    }
    return timingSafeEqual(await hash(password, this.stored.salt), this.stored.hash);
  }

  /** Sets a new password; the caller checked the current one and `passwordProblem`. */
  async change(next: string): Promise<void> {
    const salt = randomBytes(16);
    const stored = { salt, hash: await hash(next, salt) };
    await writePrivateFile(
      this.path,
      `${JSON.stringify({
        admin: { salt: salt.toString('base64'), hash: stored.hash.toString('base64') },
      })}\n`,
    );
    this.stored = stored;
    await this.audit?.append({
      event: 'settings',
      actor: ADMIN_USER,
      detail: 'changed the console admin password',
    });
  }
}
