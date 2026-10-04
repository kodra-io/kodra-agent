import { createHash } from 'node:crypto';

export interface Alert {
  /** Stable id: Alertmanager's fingerprint, or a hash of the labels. */
  fingerprint: string;
  name: string;
  severity: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
}

export interface AlertSourceOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Alertmanager base URL; preferred when set. */
  alertmanagerUrl?: string | undefined;
  /** Prometheus base URL, used when there is no Alertmanager. */
  prometheusUrl?: string | undefined;
  /** Optional bearer token for Prometheus. */
  token?: string | undefined;
}

const strings = (value: unknown): Record<string, string> =>
  value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

function labelHash(labels: Record<string, string>): string {
  const canonical = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Firing alerts: Alertmanager's v2 API (active, not silenced, not inhibited), or
 * Prometheus' /api/v1/alerts. Throws on a failed request so the caller can report it.
 */
export async function fetchFiringAlerts(opts: AlertSourceOptions): Promise<Alert[]> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  if (opts.alertmanagerUrl) {
    const url = `${opts.alertmanagerUrl.replace(/\/+$/, '')}/api/v2/alerts?active=true&silenced=false&inhibited=false`;
    const res = await opts.fetch(url, {
      headers: { accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Alertmanager answered HTTP ${String(res.status)}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('Alertmanager sent an unexpected response');
    return body.map((raw: Record<string, unknown>) => {
      const labels = strings(raw['labels']);
      return {
        fingerprint:
          typeof raw['fingerprint'] === 'string' ? raw['fingerprint'] : labelHash(labels),
        name: labels['alertname'] ?? 'unnamed alert',
        severity: labels['severity'] ?? 'unknown',
        labels,
        annotations: strings(raw['annotations']),
        startsAt: typeof raw['startsAt'] === 'string' ? raw['startsAt'] : '',
      };
    });
  }
  if (!opts.prometheusUrl) return [];
  const res = await opts.fetch(`${opts.prometheusUrl.replace(/\/+$/, '')}/api/v1/alerts`, {
    headers: {
      accept: 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    signal,
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`Prometheus answered HTTP ${String(res.status)}`);
  const body = (await res.json()) as { data?: { alerts?: Record<string, unknown>[] } };
  return (body.data?.alerts ?? [])
    .filter((a) => a['state'] === 'firing')
    .map((raw) => {
      const labels = strings(raw['labels']);
      return {
        fingerprint: labelHash(labels),
        name: labels['alertname'] ?? 'unnamed alert',
        severity: labels['severity'] ?? 'unknown',
        labels,
        annotations: strings(raw['annotations']),
        startsAt: typeof raw['activeAt'] === 'string' ? raw['activeAt'] : '',
      };
    });
}
