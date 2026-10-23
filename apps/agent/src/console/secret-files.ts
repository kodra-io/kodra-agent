import type { SecretFormat } from '@kodra-agent/schema';
import { utils } from 'ssh2';
import { parse } from 'yaml';

/**
 * File secrets the console takes pasted or uploaded (M28): a kubeconfig or an SSH private key.
 * Their shape is checked before the connector's own test, so a broken file gets a plain reason.
 * Reasons never quote the file.
 */

/** Big enough for a kubeconfig with embedded certificates; the console's action limit is above. */
export const MAX_SECRET_FILE = 48 * 1024;

/** What is wrong with a file secret, or null when its shape is right. */
export function secretShapeProblem(format: SecretFormat, value: string): string | null {
  if (value.length > MAX_SECRET_FILE) return 'that file is too big';
  return format === 'kubeconfig' ? kubeconfigProblem(value) : sshKeyProblem(value);
}

function kubeconfigProblem(value: string): string | null {
  let doc: unknown;
  try {
    doc = parse(value);
  } catch {
    return 'that is not a kubeconfig (it is not YAML)';
  }
  const k = (doc ?? {}) as Record<string, unknown>;
  const named = (key: string) =>
    Array.isArray(k[key])
      ? (k[key] as unknown[]).flatMap((x) => {
          const name = (x as { name?: unknown } | null)?.name;
          return typeof name === 'string' ? [name] : [];
        })
      : [];
  if (k['kind'] !== 'Config' || named('clusters').length === 0) {
    return 'that is not a kubeconfig (it has no clusters)';
  }
  const current = k['current-context'];
  if (typeof current !== 'string' || current === '') {
    return 'the kubeconfig has no current-context; set one with kubectl config use-context';
  }
  if (!named('contexts').includes(current)) {
    return `the kubeconfig's current-context is not one of its contexts`;
  }
  return null;
}

function sshKeyProblem(value: string): string | null {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return 'that is not an SSH private key (upload the file without .pub)';
  }
  if (/ENCRYPTED/.test(value)) return 'that key has a passphrase; the agent cannot type one';
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error) {
    // ssh2's messages may quote the key, so only its passphrase case is passed on, in our words.
    return /passphrase/i.test(parsed.message)
      ? 'that key has a passphrase; the agent cannot type one'
      : 'that SSH private key could not be read';
  }
  return null;
}

/**
 * Parts of a file secret the redactor should know on their own, besides the whole value (it
 * already finds a kubeconfig's credential fields): each line of an SSH key's body.
 */
export function secretParts(format: SecretFormat, value: string): string[] {
  if (format !== 'ssh-private-key') return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && !line.startsWith('-----'));
}

/** Whether a kubeconfig signs in by running `aws` (an EKS `aws eks get-token`). */
export function usesAwsExec(kubeconfig: string): boolean {
  return /^\s*command:\s*["']?(?:[^\s"']*[/\\])?aws(?:\.exe)?["']?\s*$/m.test(kubeconfig);
}

/** The file a secret is saved as in the bundle's secrets folder, like databases-orders-tunnel-key. */
export function secretFileName(connector: string, key: string): string {
  const kebab = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('.', '-')
    .toLowerCase();
  return `${connector}-${kebab}`;
}
