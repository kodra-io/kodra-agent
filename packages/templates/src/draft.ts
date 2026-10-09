import {
  connectors,
  getConnector,
  getModelProvider,
  modelProviders,
} from '@kodra-agent/connectors';
import type { AccessLevel, Manifest, ModelProvider } from '@kodra-agent/schema';
import { z } from 'zod';

export type Target = 'compose' | 'kubernetes';
export type DestructivePolicy = 'deny' | 'require-approval';

/**
 * What the configurator edits. Every input is kept as the raw string the user typed, so
 * half-typed values survive a shared link. It has no secret fields by design: secrets are
 * only ever named, never entered.
 */
export interface AgentDraft {
  name: string;
  target: Target;
  model: { provider: ModelProvider; name: string; fields: Record<string, string> };
  connectors: Record<string, ConnectorDraft>;
  policy: {
    /** Comma- or space-separated Slack handles or user ids. */
    approvers: string;
    expiresAfterMinutes: string;
    destructiveActions: DestructivePolicy;
  };
}

export interface ConnectorDraft {
  enabled: boolean;
  access: AccessLevel;
  config: Record<string, string>;
  /** Optional secrets the user chose to include. */
  optionalSecrets: string[];
}

export function emptyDraft(): AgentDraft {
  return {
    name: '',
    target: 'compose',
    model: { provider: 'anthropic', name: '', fields: modelFieldDefaults('anthropic') },
    connectors: {},
    policy: { approvers: '', expiresAfterMinutes: '15', destructiveActions: 'deny' },
  };
}

export function modelFieldDefaults(provider: ModelProvider): Record<string, string> {
  const manifest = getModelProvider(provider);
  return Object.fromEntries(
    (manifest?.configFields ?? []).map((f) => [
      f.key,
      'default' in f && f.default !== undefined ? String(f.default) : '',
    ]),
  );
}

export function connectorDefaults(manifest: Manifest, target: Target): ConnectorDraft {
  return {
    enabled: true,
    access: manifest.accessLevels[0] ?? 'read-only',
    config: Object.fromEntries(
      manifest.configFields.map((f) => [
        f.key,
        !('default' in f) || f.default === undefined
          ? ''
          : Array.isArray(f.default)
            ? f.default.join(', ')
            : String(f.default),
      ]),
    ),
    optionalSecrets: defaultOptionalSecrets(manifest, target),
  };
}

export function defaultOptionalSecrets(manifest: Manifest, target: Target): string[] {
  return manifest.secrets
    .filter((s) => !s.required && (s.defaultFor ?? []).includes(target))
    .map((s) => s.key);
}

export function enabledConnectors(draft: AgentDraft): Manifest[] {
  return connectors.filter((c) => draft.connectors[c.id]?.enabled === true);
}

/** Splits a list input on commas, spaces, and new lines. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---- Shareable link: the draft lives in the URL hash ----

const HASH_PREFIX = '#v1.';
const MAX_HASH_LENGTH = 16_000;

const str = z.string().max(2000);
const draftSchema = z.strictObject({
  name: str,
  target: z.enum(['compose', 'kubernetes']),
  model: z.strictObject({
    provider: z.enum(modelProviders.map((p) => p.id) as [string, ...string[]]),
    name: str,
    fields: z.record(z.string(), str),
  }),
  connectors: z.record(
    z.string(),
    z.strictObject({
      enabled: z.boolean(),
      access: z.enum(['read-only', 'read-write-approved']),
      config: z.record(z.string(), str),
      optionalSecrets: z.array(z.string()).max(20),
    }),
  ),
  policy: z.strictObject({
    approvers: str,
    expiresAfterMinutes: str,
    destructiveActions: z.enum(['deny', 'require-approval']),
  }),
});

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Encodes the enabled parts of a draft for the URL hash. */
export function encodeDraft(draft: AgentDraft): string {
  const enabledOnly: AgentDraft = {
    ...draft,
    connectors: Object.fromEntries(Object.entries(draft.connectors).filter(([, c]) => c.enabled)),
  };
  return `${HASH_PREFIX}${toBase64Url(JSON.stringify(enabledOnly))}`;
}

export type DecodeResult = { ok: true; draft: AgentDraft } | { ok: false };

/**
 * Decodes a URL hash. Anything malformed, oversized, or unknown is rejected as a whole, so a
 * crafted link cannot produce a config the UI could not have produced. Unknown connector ids
 * and keys that a manifest does not define are dropped.
 */
export function decodeDraft(hash: string): DecodeResult {
  if (!hash.startsWith(HASH_PREFIX) || hash.length > MAX_HASH_LENGTH) return { ok: false };
  let data: unknown;
  try {
    data = JSON.parse(fromBase64Url(hash.slice(HASH_PREFIX.length)));
  } catch {
    return { ok: false };
  }
  const parsed = draftSchema.safeParse(data);
  if (!parsed.success) return { ok: false };

  const raw = parsed.data;
  const provider = raw.model.provider as ModelProvider;
  const modelKeys = Object.keys(modelFieldDefaults(provider));
  const result: AgentDraft = {
    name: raw.name,
    target: raw.target,
    model: {
      provider,
      name: raw.model.name,
      fields: { ...modelFieldDefaults(provider), ...pick(raw.model.fields, modelKeys) },
    },
    connectors: {},
    policy: raw.policy,
  };
  for (const [id, entry] of Object.entries(raw.connectors)) {
    const manifest = getConnector(id);
    if (!manifest) continue;
    const fieldKeys = manifest.configFields.map((f) => f.key);
    const optional = manifest.secrets.filter((s) => !s.required).map((s) => s.key);
    result.connectors[id] = {
      enabled: entry.enabled,
      access: (manifest.accessLevels as string[]).includes(entry.access)
        ? entry.access
        : (manifest.accessLevels[0] ?? 'read-only'),
      config: {
        ...connectorDefaults(manifest, raw.target).config,
        ...pick(entry.config, fieldKeys),
      },
      optionalSecrets: entry.optionalSecrets.filter((k) => optional.includes(k)),
    };
  }
  return { ok: true, draft: result };
}

function pick(record: Record<string, string>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => keys.includes(k)));
}
