import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writePrivateFile } from '../env-file.ts';
import { CONSOLE_ADMIN } from '@kodra-agent/schema';
import type { AuditLog } from '../audit.ts';

/**
 * The console's admin sign-in: `admin` with a password. There is no default password (L2):
 * `kodra-agent init` asks for one and keeps only its scrypt hash in KODRA_CONSOLE_ADMIN_HASH
 * (in .env, or the agent's Secret). A password changed in the console is kept in an
 * owner-only file next to the audit log. Whichever was set later wins, so `init
 * --reset-console-password` recovers a lost one. With neither, the console does not start.
 * Single-user for now: user accounts and roles come later.
 */

export const ADMIN_USERNAME = 'admin';
/** The admin's name in approver lists and the audit log. */
export const ADMIN_USER = CONSOLE_ADMIN;
/** Where `init` puts the hash: .env on Compose, the agent's Secret on Kubernetes. */
export const ADMIN_HASH_ENV = 'KODRA_CONSOLE_ADMIN_HASH';
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;
const HASH_PREFIX = 'scrypt1';

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
  /** When it was set, in ms since the epoch: the later of the env and the file wins. */
  setAt: number;
}

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(next: string, current: string): string | null {
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  if (next.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`;
  }
  if (next === current) {
    return 'Choose a password different from the current one.';
  }
  return null;
}

/** The KODRA_CONSOLE_ADMIN_HASH value for a password: `scrypt1:<setAt>:<salt>:<hash>`. */
export async function adminPasswordHash(password: string, setAt = Date.now()): Promise<string> {
  const salt = randomBytes(16);
  const key = await hash(password, salt);
  return [HASH_PREFIX, String(setAt), salt.toString('base64'), key.toString('base64')].join(':');
}

function parseHash(value: string): Stored | null {
  const [prefix, setAt, salt, key, ...rest] = value.trim().split(':');
  if (prefix !== HASH_PREFIX || rest.length > 0 || !salt || !key) return null;
  const at = Number(setAt);
  if (!Number.isSafeInteger(at) || at < 0) return null;
  const stored = { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(key, 'base64') };
  if (stored.salt.length !== 16 || stored.hash.length !== SCRYPT.keylen) return null;
  return { ...stored, setAt: at };
}

export class AdminAccount {
  private readonly path: string;
  private readonly envHash: string | undefined;
  private readonly audit: AuditLog | undefined;
  private stored: Stored | null = null;
  /** Never signs a usable session: the console does not start without a password. */
  private readonly unsetKey = randomBytes(32);

  constructor(opts: { path: string; envHash?: string | undefined; audit?: AuditLog }) {
    this.path = opts.path;
    this.envHash = opts.envHash?.trim() || undefined;
    this.audit = opts.audit;
  }

  async load(): Promise<void> {
    let fromEnv: Stored | null = null;
    if (this.envHash !== undefined) {
      fromEnv = parseHash(this.envHash);
      if (!fromEnv) {
        throw new Error(
          `${ADMIN_HASH_ENV} is not a console password hash. Run \`kodra-agent init --reset-console-password\`.`,
        );
      }
    }
    let fromFile: Stored | null = null;
    const text = await readFile(this.path, 'utf8').catch(() => null);
    if (text !== null) {
      // A broken file must not be skipped: refuse to start instead.
      const parsed = JSON.parse(text) as {
        admin?: { salt?: unknown; hash?: unknown; setAt?: unknown };
      };
      const { salt, hash: stored, setAt } = parsed.admin ?? {};
      if (typeof salt !== 'string' || typeof stored !== 'string') {
        throw new Error(
          `${this.path} is not a console password file. Remove it and run \`kodra-agent init --reset-console-password\`.`,
        );
      }
      fromFile = {
        salt: Buffer.from(salt, 'base64'),
        hash: Buffer.from(stored, 'base64'),
        // Files written before L2 have no time: they predate any hash init writes now.
        setAt: typeof setAt === 'number' ? setAt : 0,
      };
    }
    this.stored =
      fromEnv && fromFile
        ? fromFile.setAt > fromEnv.setAt
          ? fromFile
          : fromEnv
        : (fromEnv ?? fromFile);
  }

  /** Whether a password was set. Without one the console must not start. */
  isSet(): boolean {
    return this.stored !== null;
  }

  /** The key that signs this account's sessions: changing the password ends them all. */
  sessionKey(): Buffer {
    return this.stored?.hash ?? this.unsetKey;
  }

  async verify(password: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    if (!this.stored) {
      // No password accepts anything; hash anyway so the answer takes as long.
      await hash(password, this.unsetKey);
      return false;
    }
    return timingSafeEqual(await hash(password, this.stored.salt), this.stored.hash);
  }

  /** Sets a new password; the caller checked the current one and `passwordProblem`. */
  async change(next: string): Promise<void> {
    const salt = randomBytes(16);
    const stored = { salt, hash: await hash(next, salt), setAt: Date.now() };
    await writePrivateFile(
      this.path,
      `${JSON.stringify({
        admin: {
          salt: salt.toString('base64'),
          hash: stored.hash.toString('base64'),
          setAt: stored.setAt,
        },
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
