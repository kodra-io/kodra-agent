import { X509Certificate } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { parse } from 'yaml';
import type { AuditRecord } from '../audit.ts';
import { secretLabel } from '../config.ts';
import type { ConnectorInput } from '../mcp/host.ts';

/**
 * Secret hygiene for the daily digest (M29b): when each secret expires, if it says so (a
 * kubeconfig's token or client certificate, any JWT), and when it was last set (replaced in
 * the console, or the file's time). Only labels and dates leave here, never a value.
 */
export interface SecretHealth {
  /** Stable, like kubernetes.kubeconfig. */
  id: string;
  /** Value-free, like "Kubernetes kubeconfig (file /secrets/kubeconfig)". */
  label: string;
  expiresAt: Date | null;
  setAt: Date | null;
}

/** The earliest expiry a secret carries: a JWT's `exp`, or a kubeconfig's tokens and certificates. */
export function secretExpiry(value: string): Date | null {
  const dates = [jwtExpiry(value.trim()), ...kubeconfigExpiries(value)].filter(
    (d): d is Date => d !== null,
  );
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));
}

function jwtExpiry(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

function kubeconfigExpiries(value: string): (Date | null)[] {
  if (!/^\s*kind:\s*Config\s*$/m.test(value)) return [];
  let doc: unknown;
  try {
    doc = parse(value);
  } catch {
    return [];
  }
  const users = (doc as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return [];
  return users.flatMap((u) => {
    const user = (u as { user?: Record<string, unknown> } | null)?.user ?? {};
    const out: (Date | null)[] = [];
    if (typeof user['token'] === 'string') out.push(jwtExpiry(user['token']));
    const cert = user['client-certificate-data'];
    if (typeof cert === 'string') {
      try {
        out.push(new Date(new X509Certificate(Buffer.from(cert, 'base64')).validTo));
      } catch {
        out.push(null);
      }
    }
    return out;
  });
}

/** Each connector secret's expiry and age, from its value, the audit log, and its file. */
export async function secretHealth(
  inputs: readonly ConnectorInput[],
  records: readonly AuditRecord[],
): Promise<SecretHealth[]> {
  const out: SecretHealth[] = [];
  for (const input of inputs) {
    for (const use of input.component.secrets) {
      const value = input.secrets[use.spec.key];
      if (value === undefined) continue;
      // The console audits "replaced <connector> <key> (...)" each time it saves one.
      const replaced = records
        .filter(
          (r) =>
            r.event === 'settings' &&
            r.detail?.startsWith(`replaced ${use.componentName} ${use.spec.key} `) === true,
        )
        .map((r) => Date.parse(r.ts));
      const fileTime =
        use.ref.scheme === 'file'
          ? await stat(use.ref.path).then(
              (s) => s.mtime.getTime(),
              () => null,
            )
          : null;
      const times = [...replaced, ...(fileTime === null ? [] : [fileTime])];
      out.push({
        id: `${use.component}.${use.spec.key}`,
        label: secretLabel(use),
        expiresAt: secretExpiry(value),
        setAt: times.length === 0 ? null : new Date(Math.max(...times)),
      });
    }
  }
  return out;
}
