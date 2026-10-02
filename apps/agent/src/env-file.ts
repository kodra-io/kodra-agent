import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Reads and writes .env files in the format Docker Compose understands: KEY=value, with
 * single quotes for literal values (no $ interpolation) and double quotes when the value
 * itself contains a single quote.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', rest = ''] = match;
    out.set(key, unquote(rest));
  }
  return out;
}

function unquote(raw: string): string {
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[++i];
        out += next === 'n' ? '\n' : (next ?? '');
      } else if (ch === '"') {
        break;
      } else {
        out += ch ?? '';
      }
    }
    return out;
  }
  // Unquoted: a " #" starts a comment.
  return raw.replace(/\s+#.*$/, '').trim();
}

export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$')}"`;
}

/**
 * Writes a file readable only by its owner, atomically: a temporary file is written with
 * mode 0600 and renamed over the target, so a crash never leaves a partial secrets file.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${String(process.pid)}.${String(Date.now())}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await chmod(path, 0o600);
}

/** Merges new values into an existing .env, keeping keys this tool does not manage. */
export function renderEnvFile(
  existingText: string | null,
  values: ReadonlyMap<string, string>,
  header: string,
): string {
  const lines: string[] = [];
  const written = new Set<string>();
  if (existingText) {
    for (const line of existingText.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      const key = match?.[1];
      if (key !== undefined && values.has(key)) {
        lines.push(`${key}=${formatEnvValue(values.get(key) ?? '')}`);
        written.add(key);
      } else {
        lines.push(line);
      }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  } else {
    lines.push(header);
  }
  for (const [key, value] of values) {
    if (!written.has(key)) lines.push(`${key}=${formatEnvValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
