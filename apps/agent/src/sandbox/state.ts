import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** One test deploy the agent made and has not destroyed yet (B2). */
export interface SandboxTest {
  /** 8 hex characters; the release is `kt-<id>`. */
  id: string;
  release: string;
  namespace: string;
  repo: string;
  branch: string;
  sha: string;
  /** repository:tag */
  image: string;
  requestedBy: string;
  createdAt: string;
  /** When the sweep destroys it. */
  expiresAt: string;
  /** What the smoke test found, once it ran. */
  result?: string;
}

/** Where the list lives: next to the audit log, so it survives restarts with it. */
export const sandboxStatePath = (auditPath: string) => join(dirname(auditPath), 'sandbox.json');

export async function readTests(path: string): Promise<SandboxTest[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as SandboxTest[]) : [];
  } catch {
    return [];
  }
}

/** Serializes changes, so a deploy and a sweep never lose each other's write. */
let queue: Promise<unknown> = Promise.resolve();

export function updateTests(
  path: string,
  change: (tests: SandboxTest[]) => SandboxTest[],
): Promise<SandboxTest[]> {
  const next = queue.then(async () => {
    const tests = change(await readTests(path));
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(tests, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return tests;
  });
  queue = next.catch(() => undefined);
  return next;
}
