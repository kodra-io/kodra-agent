import type { Manifest } from '@kodra-agent/schema';
import { parse } from 'yaml';

export type ScaleLimit = NonNullable<Manifest['scaleLimit']>;

/**
 * Whether a scale call is a big cut (M29): to zero, or to less than half of what the object
 * runs now. Big cuts are treated as destructive. `readCurrent` returns the object as the read
 * tool shows it, or null when it could not be read; then only a cut to zero is caught.
 */
export async function bigCut(
  limit: ScaleLimit,
  args: Readonly<Record<string, unknown>>,
  readCurrent: (args: Record<string, unknown>) => Promise<string | null>,
): Promise<string | null> {
  const target = Number(args[limit.replicasArg]);
  if (!Number.isInteger(target) || target < 0) return null;
  const what = typeof args['name'] === 'string' ? args['name'] : 'it';
  if (target === 0) return `scaling ${what} to 0 stops it`;
  const copied = Object.fromEntries(
    limit.current.copyArgs.flatMap((k) => (args[k] === undefined ? [] : [[k, args[k]]])),
  );
  const current = currentReplicas(await readCurrent(copied).catch(() => null), limit.current.path);
  if (current !== null && target < current / 2) {
    return `scaling ${what} from ${String(current)} to ${String(target)} cuts it by more than half`;
  }
  return null;
}

/** The replicas at `path` in the object's YAML (or JSON), or null. */
export function currentReplicas(text: string | null, path: readonly string[]): number | null {
  if (!text) return null;
  let node: unknown;
  try {
    node = parse(text);
  } catch {
    return null;
  }
  for (const key of path) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' && Number.isInteger(node) && node >= 0 ? node : null;
}
