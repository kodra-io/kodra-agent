/**
 * The agent's read-only console API (apps/agent/src/console). Same origin only; the session
 * is an HttpOnly cookie the page never sees.
 */

export interface StatusView {
  version: string;
  model: string;
  target: string;
  startedAt: string;
  uptimeSeconds: number;
  slack: boolean;
  monitoring: boolean;
  connectors: { id: string; name: string; available: boolean }[];
}

export interface ConnectorView {
  id: string;
  name: string;
  access: string | null;
  available: boolean;
  reason?: string;
  hint?: string;
  tools: { name: string; risk: string; limits: string[] }[];
}

export interface AuditRecord {
  ts: string;
  event: string;
  actor: string;
  task?: string;
  connector?: string;
  tool?: string;
  risk?: string;
  decision?: string;
  detail?: string;
}

export interface Investigation {
  ts: string;
  alert: string;
  severity: string;
  summary: string;
  findings: string;
  stoppedBy?: string;
}

export interface UsageTotals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
}

export interface UsageView {
  model: string;
  pricing: { source: string; asOf: string | null; overridden: boolean } | null;
  totals: UsageTotals;
  days: (UsageTotals & { day: string })[];
  questions: (UsageTotals & { task: string; ts: string; actor: string })[];
}

export interface ApprovalView {
  id: string;
  ts: string;
  connector: string;
  tool: string;
  risk: string;
  requestedBy: string;
  args: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export class SignedOut extends Error {
  constructor() {
    super('signed out');
  }
}

export async function get<T>(route: string, query: Record<string, string> = {}): Promise<T> {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ''));
  const res = await fetch(`/api/${route}${params.size ? `?${params.toString()}` : ''}`, {
    credentials: 'same-origin',
  });
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return (await res.json()) as T;
}

export async function signedIn(): Promise<boolean> {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  return res.ok && ((await res.json()) as { signedIn?: boolean }).signedIn === true;
}

export async function signIn(token: string): Promise<'ok' | 'wrong' | 'too-many'> {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 429) return 'too-many';
  return res.ok ? 'ok' : 'wrong';
}

export async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
