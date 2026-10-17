/**
 * The agent's console API (apps/agent/src/console). Same origin only; the session is an
 * HttpOnly cookie the page never sees. Writes send a JSON body and the x-kodra-console header.
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
  /** Who paused changes, and when; null while changes may run. */
  paused?: { by: string; at: string } | null;
  budget?: { month: string; limit: number | null; spent: number | null; over: boolean };
}

export interface OverviewView {
  investigationsToday: number;
  lastInvestigation: { alert: string; ts: string } | null;
  changesThisWeek: { approved: number; denied: number; expired: number };
  recentChanges: ApprovalView[];
  /** The newest audit record: note it, and a later rewrite of history shows. */
  auditHead?: { seq: number; hash: string } | null;
}

export function pauseAgent(): Promise<unknown> {
  return post('agent/pause', {});
}

export function resumeAgent(): Promise<unknown> {
  return post('agent/resume', {});
}

export interface ConnectorView {
  id: string;
  name: string;
  category: string;
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
  /** A proposed change's title. */
  title?: string;
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

/** Who is signed in: `console:admin`, `console` (the shared token), or `console:<name>`. */
export interface Session {
  signedIn: boolean;
  user?: string;
  canApprove?: boolean;
  features?: { chat?: boolean };
  /** Signed in as admin with the default password: it must be changed first. */
  mustChangePassword?: boolean;
}

export async function session(): Promise<Session> {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (!res.ok) return { signedIn: false };
  return (await res.json()) as Session;
}

/** An API error with the server's message. */
export class ApiError extends Error {
  readonly status: number;
  /** Why an approval was refused, as a code to translate. */
  readonly refusal: string | undefined;
  constructor(status: number, message: string, refusal?: string) {
    super(message);
    this.status = status;
    this.refusal = refusal;
  }
}

export async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${route}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-kodra-console': '1' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new SignedOut();
  const data = (await res.json().catch(() => ({}))) as { error?: string; refusal?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `HTTP ${String(res.status)}`, data.refusal);
  }
  return data as T;
}

/** A change waiting for a decision. Already redacted by the agent. */
export interface PendingApproval {
  id: string;
  connector: string;
  tool: string;
  risk: string;
  args: string;
  reason: string;
  requestedBy: string;
  expiresAt: string;
  /** The environment's name, or null for the default policy. */
  environment: string | null;
  /** Different approvers needed, and who has approved so far. */
  needed: number;
  approvedBy: string[];
  /** Why the signed-in person cannot approve this one (a code), or null when they can. */
  cannotApprove: string | null;
  /** What approving still needs: a change reference (with its pattern), a break-glass reason. */
  needs: { changeRef: boolean; reason: boolean };
  changeRefPattern: string | null;
  /** The change reference and override reason an earlier approver gave. */
  changeRef: string | null;
  override: string | null;
  /** The freeze this request overrides. */
  freeze: { name: string; until: string; timezone: string } | null;
  /** A proposed change: its title and preview (a diff for file edits). */
  title?: string;
  preview?: string;
}

export function decide(
  id: string,
  approve: boolean,
  details: { note?: string; changeRef?: string; reason?: string } = {},
): Promise<{ result: string }> {
  const given = Object.fromEntries(Object.entries(details).filter(([, v]) => v));
  return post('approvals/decide', { id, approve, ...given });
}

export interface ConversationSummary {
  id: string;
  title: string;
  startedBy: string;
  createdAt: string;
  busy: boolean;
}

export type ToolState = 'running' | 'ok' | 'error' | 'blocked' | 'denied' | 'expired';

/** One step of a conversation, from the agent's event stream. */
export type ChatEvent = { seq: number; ts: string } & (
  | { type: 'user'; text: string; by: string }
  | { type: 'status'; state: 'queued' | 'working' | 'idle' }
  | {
      type: 'answer';
      text: string;
      usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
      stoppedBy?: string;
    }
  | { type: 'error'; message: string }
  | {
      type: 'tool';
      call: string;
      connector: string;
      tool: string;
      risk: string;
      args: string;
      state: ToolState;
      detail?: string;
    }
  | {
      type: 'approval';
      call: string;
      id: string;
      connector: string;
      tool: string;
      risk: string;
      args: string;
      reason: string;
      expiresAt: string;
      environment?: string | null;
      needed?: number;
      needs?: { changeRef: boolean; reason: boolean };
      changeRefPattern?: string | null;
      freeze?: { name: string; until: string; timezone: string } | null;
      title?: string;
      preview?: string;
    }
  | { type: 'decision'; call: string; id: string; decision: string; by?: string }
  /** A piece of the answer while it is written (seq 0: live only, never kept). */
  | { type: 'text'; text: string }
);

export async function signIn(
  credentials: { username: string; password: string } | { token: string },
): Promise<'ok' | 'wrong' | 'too-many'> {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (res.status === 429) return 'too-many';
  return res.ok ? 'ok' : 'wrong';
}

/** The admin's new password. Fails as `wrong-current`, `weak`, `too-many`, or `failed`. */
export async function changePassword(
  current: string,
  next: string,
): Promise<'ok' | 'wrong-current' | 'weak' | 'too-many' | 'failed'> {
  const res = await fetch('/api/password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-kodra-console': '1' },
    body: JSON.stringify({ current, next }),
  });
  if (res.ok) return 'ok';
  if (res.status === 429) return 'too-many';
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return body.code === 'wrong-current' || body.code === 'weak' ? body.code : 'failed';
}

export async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}

/** Text in the configurator's two languages, from a connector manifest. */
export interface Localized {
  en: string;
  ar: string;
}

export type ConfigField =
  | {
      kind: 'string';
      key: string;
      required: boolean;
      description: Localized;
      example?: string;
      patternHint?: Localized;
    }
  | { kind: 'url'; key: string; required: boolean; description: Localized; example?: string }
  | {
      kind: 'string-list';
      key: string;
      required: boolean;
      description: Localized;
      example?: string[];
      patternHint?: Localized;
    }
  | {
      kind: 'integer';
      key: string;
      required: boolean;
      description: Localized;
      min: number;
      max: number;
    };

export interface SecretSetting {
  key: string;
  label: string;
  envVar: string;
  required: boolean;
  set: boolean;
  writable: boolean;
  ref: string;
  description: Localized;
  howToCreate: Localized;
}

export interface ConnectorSettings {
  id: string;
  name: string;
  category: string;
  status: 'available' | 'coming-soon';
  description: Localized;
  accessLevels: string[];
  summaries: Partial<Record<string, Localized[]>>;
  enabled: boolean;
  access: string | null;
  config: Record<string, unknown>;
  fields: ConfigField[];
  secrets: SecretSetting[];
  tools: { read: number; write: number; destructive: number };
}

export interface SettingsView {
  target: 'compose' | 'kubernetes';
  editable: boolean;
  why: string | null;
  base: string;
  model: { provider: string; name: string };
  policy: { approvers: string[]; expiresAfterMinutes: number; destructiveActions: string };
  limits: {
    maxSteps: number;
    tokenBudget: number;
    timeoutMinutes: number;
    monthlyBudgetUsd?: number;
  };
  console: { chat: boolean };
  connectors: ConnectorSettings[];
  lastChange: { by: string; at: string; detail: string } | null;
  undoable: boolean;
  /** What a policy change does here: audited, announced, or held for a second approver. */
  policyChanges: 'audited' | 'announced' | 'second-approver';
  waiting: PendingPolicyChange[];
}

/** A policy change from the console, waiting for a second approver (strict). */
export interface PendingPolicyChange {
  id: string;
  title: string;
  requestedBy: string;
  expiresAt: string;
}

export interface SettingsPatch {
  connectors?: Record<
    string,
    { enabled?: boolean; access?: string; config?: Record<string, unknown> }
  >;
  policy?: { approvers?: string[]; expiresAfterMinutes?: number; destructiveActions?: string };
  model?: { name?: string };
  limits?: {
    maxSteps?: number;
    tokenBudget?: number;
    timeoutMinutes?: number;
    monthlyBudgetUsd?: number | null;
  };
  console?: { chat?: boolean };
}

export type AccessChange =
  | { code: 'enabled'; connector: string }
  | { code: 'write'; connector: string }
  | { code: 'scope'; connector: string; field: string; added: string[] }
  | { code: 'approver'; approver: string }
  | { code: 'destructive' }
  | { code: 'chat' }
  | { code: 'model'; from: string; to: string };

export interface SettingsPreview {
  ok: boolean;
  errors: string[];
  diff: string;
  base: string;
  moreAccess: AccessChange[];
  changed: string[];
  /** Whether it changes who may change what. */
  policy: boolean;
}

export interface CheckRow {
  check: string;
  status: string;
  message: string;
}

export interface PersonView {
  who: string;
  canApprove: boolean;
  tokenSet: boolean;
  envVar: string;
}

export interface SessionInfo {
  id: string;
  user: string;
  since: string;
  lastSeen: string;
}

export interface PeopleView {
  editable: boolean;
  people: PersonView[];
  otherApprovers: string[];
  sessions: SessionInfo[];
  waiting: PendingPolicyChange[];
}

/** The dashboard (GET /api/dashboard): what each connector can see, from its read tools. */
export type RunState = 'passed' | 'failed' | 'running' | 'other';

export interface PodsData {
  kind: 'pods';
  counts: { running: number; pending: number; failing: number; completed: number };
  pods: { namespace: string; name: string; status: string; ready: string; restarts: number }[];
}

export interface DeploymentsData {
  kind: 'deployments';
  ready: number;
  total: number;
  deployments: { namespace: string; name: string; ready: number; desired: number }[];
}

export interface EventsData {
  kind: 'events';
  warnings: { reason: string; object: string; message: string; at: string; count: number }[];
}

export interface RunsData {
  kind: 'runs';
  counts: Record<RunState, number>;
  runs: {
    id: string;
    name: string | null;
    ref: string;
    state: RunState;
    status: string;
    url: string | null;
    at: string;
  }[];
}

export interface JobsData {
  kind: 'jobs';
  counts: Record<RunState, number>;
  jobs: { name: string; state: RunState; status: string; url: string | null }[];
}

export interface TargetResult {
  target: string | null;
  data?: PodsData | DeploymentsData | EventsData | RunsData | JobsData;
  error?: string;
}

export interface PanelResult {
  id: string;
  title: Localized;
  view: 'pods' | 'deployments' | 'events' | 'runs' | 'jobs';
  results: TargetResult[];
  note?: 'no-targets' | 'unavailable';
}

export interface DashboardView {
  updatedAt: string;
  connectors: { id: string; displayName: string; panels: PanelResult[] }[];
}

/** The model picker (GET /api/settings/models). */
export interface ModelOptionsView {
  provider: string;
  current: string;
  options: {
    name: string;
    price: { inputPerMTok: number; outputPerMTok: number } | null;
    /** Whether the provider listed it for the agent's key; null when it has no list. */
    available: boolean | null;
    /** This month's usage priced at this model, in US dollars. */
    monthCost: number | null;
  }[];
  listError: string | null;
  month: string;
}

/** A model provider the console can switch to (GET /api/settings/providers). */
export interface ProviderView {
  id: string;
  name: string;
  description: Localized;
  sends: Localized[];
  fields: ConfigField[];
  secrets: {
    key: string;
    envVar: string;
    description: Localized;
    howToCreate: Localized;
    set: boolean;
  }[];
  config: Record<string, string>;
  writable: boolean;
}

/** A model whose context window is smaller than the agent's prompt (Ollama). */
export interface ContextWarning {
  model: string;
  needed: number;
  window: number;
}
