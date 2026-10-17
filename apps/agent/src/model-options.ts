import type { ModelPrice } from '@kodra-agent/schema';
import { generateText, type LanguageModel } from 'ai';
import type { Component } from './config.ts';
import { costOf } from './console/data.ts';
import type { AuditRecord } from './audit.ts';
import type { Redactor } from './redactor.ts';

/**
 * The console's model picker: the models the key can use (from the provider's own model
 * list, the same endpoint doctor checks the key with), merged with the provider manifest's
 * prices, and what this month's usage would have cost on each. Choosing one is checked with
 * a tiny call before it is saved.
 */

export interface ModelOption {
  name: string;
  /** List price per million tokens, or null when the manifest does not know the model. */
  price: ModelPrice | null;
  /** Whether the provider listed it for this key; null when the provider has no list. */
  available: boolean | null;
  /** This month's usage priced at this model's rates, in US dollars. */
  monthCost: number | null;
}

export interface ModelOptionsView {
  provider: string;
  current: string;
  options: ModelOption[];
  /** Why the provider's list could not be read (the options are then the known ones). */
  listError: string | null;
  month: string;
}

export interface ListContext {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Test hosts for the fixed public APIs. */
  endpoints?: Partial<Record<'anthropic' | 'openai', string>>;
}

const MAX_LISTED = 200;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** The provider's model list for this key, or null when the provider has none to read. */
export async function listProviderModels(
  model: Component,
  secrets: Readonly<Record<string, string>>,
  ctx: ListContext,
): Promise<{ ids: string[] } | { error: string } | null> {
  const s = model.settings;
  let url: string;
  let headers: Record<string, string> = {};
  let pick: (json: unknown) => unknown[];
  const data = (json: unknown) => {
    const list = (json as { data?: unknown } | null)?.data;
    return Array.isArray(list) ? list.map((m) => (m as { id?: unknown }).id) : [];
  };
  switch (model.id) {
    case 'anthropic':
      url = join(
        str(s['baseUrl']) ?? ctx.endpoints?.anthropic ?? 'https://api.anthropic.com',
        '/v1/models?limit=1000',
      );
      headers = { 'x-api-key': secrets['apiKey'] ?? '', 'anthropic-version': '2023-06-01' };
      pick = data;
      break;
    case 'openai':
      url = join(
        str(s['baseUrl']) ?? ctx.endpoints?.openai ?? 'https://api.openai.com',
        '/v1/models',
      );
      headers = { authorization: `Bearer ${secrets['apiKey'] ?? ''}` };
      pick = data;
      break;
    case 'azure-openai': {
      const endpoint = str(s['endpoint']);
      if (!endpoint) return { error: 'no endpoint configured' };
      url = join(endpoint, '/openai/v1/models');
      headers = { 'api-key': secrets['apiKey'] ?? '' };
      pick = data;
      break;
    }
    case 'ollama': {
      const base = str(s['baseUrl']);
      if (!base) return { error: 'no baseUrl configured' };
      url = join(base, '/api/tags');
      pick = (json) => {
        const list = (json as { models?: unknown } | null)?.models;
        return Array.isArray(list) ? list.map((m) => (m as { name?: unknown }).name) : [];
      };
      break;
    }
    default:
      // Bedrock: model access is per account and region; the known models are offered.
      return null;
  }
  try {
    const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    const ids = pick(await res.json())
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
      .slice(0, MAX_LISTED);
    return { ids };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** This month's (UTC) token totals across every model call in the audit log. */
export function monthTotals(records: readonly AuditRecord[], month: string) {
  const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of records) {
    if (r.event !== 'model.call' || !r.usage || !r.ts.startsWith(month)) continue;
    totals.calls += 1;
    totals.input += r.usage.input;
    totals.cacheRead += r.usage.cacheRead;
    totals.cacheWrite += r.usage.cacheWrite;
    totals.output += r.usage.output;
  }
  return totals;
}

/**
 * The picker's options: priced models first (in the manifest's order), then other models the
 * provider lists. The current model is always included.
 */
export function modelOptions(opts: {
  provider: string;
  current: string;
  prices: Readonly<Record<string, ModelPrice>>;
  listed: { ids: string[] } | { error: string } | null;
  records: readonly AuditRecord[];
  month: string;
}): ModelOptionsView {
  const listed = opts.listed && 'ids' in opts.listed ? new Set(opts.listed.ids) : null;
  const totals = monthTotals(opts.records, opts.month);
  const names = [...new Set([...Object.keys(opts.prices), ...(listed ?? []), opts.current])];
  const options = names.map((name) => {
    const price = opts.prices[name] ?? null;
    return {
      name,
      price,
      available: listed ? listed.has(name) : null,
      monthCost: price ? costOf(totals, price) : null,
    };
  });
  const rank = (o: ModelOption) => (o.price ? 0 : 1);
  return {
    provider: opts.provider,
    current: opts.current,
    options: options
      .map((o, i) => ({ o, i }))
      .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
      .map(({ o }) => o),
    listError: opts.listed && 'error' in opts.listed ? opts.listed.error : null,
    month: opts.month,
  };
}

/**
 * One tiny call to the model (a few output tokens), proving the name works with this key
 * before it is saved. Errors are redacted; nothing of the answer is kept.
 */
export async function testModel(
  model: LanguageModel,
  redactor: Redactor,
  timeoutMs = 30_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await generateText({
      model,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      maxOutputTokens: 5,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: redactor.redact(message).slice(0, 300) };
  }
}
