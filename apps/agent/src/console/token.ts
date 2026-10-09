import { randomBytes } from 'node:crypto';

/** The environment variable that holds the console sign-in token (a secret, never printed). */
export const CONSOLE_TOKEN_ENV = 'KODRA_CONSOLE_TOKEN';

/** A new console token: 32 random bytes, base64url. */
export function newConsoleToken(): string {
  return randomBytes(32).toString('base64url');
}
