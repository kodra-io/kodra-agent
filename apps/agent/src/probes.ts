import { request as httpRequest } from 'node:http';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Component } from './config.ts';
import type { KubernetesFactory } from './kubernetes.ts';

export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface ProbeResult {
  status: ProbeStatus;
  message: string;
  hint?: string;
}

export interface ProbeContext {
  component: Component;
  /** Resolved secret values, keyed by the manifest secret key. Never logged. */
  secrets: Readonly<Record<string, string>>;
  fetch: typeof fetch;
  kubernetes: KubernetesFactory;
  timeoutMs: number;
  /** Overrides for fixed public API hosts (tests point these at local fake servers). */
  endpoints?: Partial<Record<'github' | 'slack' | 'anthropic' | 'openai' | 'sts', string>>;
}

export type Probe = (ctx: ProbeContext) => Promise<ProbeResult>;

const pass = (message: string): ProbeResult => ({ status: 'pass', message });
const fail = (message: string, hint?: string): ProbeResult =>
  hint === undefined ? { status: 'fail', message } : { status: 'fail', message, hint };
const skip = (message: string): ProbeResult => ({ status: 'skip', message });

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

interface HttpCheck {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

type HttpOutcome =
  { ok: true; status: number; json: unknown } | { ok: false; status?: number; reason: string };

/** One read-only HTTP call with a timeout. Response bodies are parsed, never printed. */
async function http(ctx: ProbeContext, check: HttpCheck): Promise<HttpOutcome> {
  let res: Response;
  try {
    res = await ctx.fetch(check.url, {
      method: check.method ?? 'GET',
      headers: { accept: 'application/json', 'user-agent': 'kodra-agent', ...check.headers },
      ...(check.body === undefined ? {} : { body: check.body }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      reason:
        name === 'TimeoutError'
          ? `no answer within ${String(ctx.timeoutMs / 1000)}s`
          : 'could not connect',
    };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${String(res.status)}` };
  return { ok: true, status: res.status, json };
}

function authHint(status: number | undefined, what: string): string | undefined {
  if (status === 401)
    return `The ${what} was rejected. Check it, or run \`kodra-agent init\` again.`;
  if (status === 403) return `The ${what} works but lacks access. Check its minimum scopes.`;
  if (status === 404) return 'Not found, or the token cannot see it.';
  return undefined;
}

async function eachTarget(
  targets: readonly string[],
  noun: string,
  check: (target: string) => Promise<HttpOutcome>,
  what: string,
): Promise<ProbeResult> {
  if (targets.length === 0) return skip(`no ${noun}s configured`);
  for (const target of targets) {
    const outcome = await check(target);
    if (!outcome.ok) {
      return fail(`${noun} ${target}: ${outcome.reason}`, authHint(outcome.status, what));
    }
  }
  return pass(`can read ${String(targets.length)} ${noun}${targets.length === 1 ? '' : 's'}`);
}

function needSecret(ctx: ProbeContext, key: string): string | ProbeResult {
  return ctx.secrets[key] ?? skip(`${key} is not set`);
}

/** Implementations for every probe id the manifests name. */
export const probes: Record<string, Probe> = {
  'github.read-repos': async (ctx) => {
    const token = needSecret(ctx, 'token');
    if (typeof token !== 'string') return token;
    const base = ctx.endpoints?.github ?? 'https://api.github.com';
    return eachTarget(
      list(ctx.component.settings['repos']),
      'repo',
      (repo) =>
        http(ctx, {
          url: joinUrl(base, `/repos/${repo}`),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2026-03-10',
          },
        }),
      'GitHub token',
    );
  },

  'gitlab.read-projects': async (ctx) => {
    const token = needSecret(ctx, 'token');
    if (typeof token !== 'string') return token;
    const base = str(ctx.component.settings['url']) ?? 'https://gitlab.com';
    return eachTarget(
      list(ctx.component.settings['projects']),
      'project',
      (project) =>
        http(ctx, {
          url: joinUrl(base, `/api/v4/projects/${encodeURIComponent(project)}`),
          headers: { 'private-token': token },
        }),
      'GitLab token',
    );
  },

  'slack.auth-test': async (ctx) => {
    const token = needSecret(ctx, 'botToken');
    if (typeof token !== 'string') return token;
    return slackCall(ctx, 'auth.test', token, 'bot token');
  },

  'slack.open-socket-connection': async (ctx) => {
    const token = needSecret(ctx, 'appToken');
    if (typeof token !== 'string') return token;
    return slackCall(ctx, 'apps.connections.open', token, 'app token');
  },

  'anthropic.list-models': async (ctx) => {
    const key = needSecret(ctx, 'apiKey');
    if (typeof key !== 'string') return key;
    const base =
      str(ctx.component.settings['baseUrl']) ??
      ctx.endpoints?.anthropic ??
      'https://api.anthropic.com';
    const out = await http(ctx, {
      url: joinUrl(base, '/v1/models?limit=1'),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    return out.ok ? pass('API key accepted') : fail(out.reason, authHint(out.status, 'API key'));
  },

  'openai.list-models': async (ctx) => {
    const key = needSecret(ctx, 'apiKey');
    if (typeof key !== 'string') return key;
    const base =
      str(ctx.component.settings['baseUrl']) ?? ctx.endpoints?.openai ?? 'https://api.openai.com';
    const out = await http(ctx, {
      url: joinUrl(base, '/v1/models'),
      headers: { authorization: `Bearer ${key}` },
    });
    return out.ok ? pass('API key accepted') : fail(out.reason, authHint(out.status, 'API key'));
  },

  'azure-openai.list-models': async (ctx) => {
    const key = needSecret(ctx, 'apiKey');
    if (typeof key !== 'string') return key;
    const endpoint = str(ctx.component.settings['endpoint']);
    if (!endpoint) return fail('no endpoint configured');
    const out = await http(ctx, {
      url: joinUrl(endpoint, '/openai/v1/models'),
      headers: { 'api-key': key },
    });
    return out.ok ? pass('API key accepted') : fail(out.reason, authHint(out.status, 'API key'));
  },

  'grafana.get-current-org': async (ctx) => {
    const token = needSecret(ctx, 'serviceAccountToken');
    if (typeof token !== 'string') return token;
    const url = str(ctx.component.settings['url']);
    if (!url) return fail('no url configured');
    const out = await http(ctx, {
      url: joinUrl(url, '/api/org/'),
      headers: { authorization: `Bearer ${token}` },
    });
    return out.ok
      ? pass('service account token accepted')
      : fail(out.reason, authHint(out.status, 'service account token'));
  },

  'prometheus.query-up': async (ctx) => {
    const url = str(ctx.component.settings['url']);
    if (!url) return fail('no url configured');
    const token = ctx.secrets['bearerToken'];
    const out = await http(ctx, {
      url: joinUrl(url, '/api/v1/query?query=up'),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!out.ok) {
      return fail(
        out.reason,
        out.status === undefined ? 'Check the Prometheus address.' : authHint(out.status, 'token'),
      );
    }
    const status = (out.json as { status?: unknown } | null)?.status;
    return status === 'success'
      ? pass('query API answers')
      : fail('unexpected response from the query API');
  },

  'ollama.list-models': async (ctx) => {
    const url = str(ctx.component.settings['baseUrl']);
    if (!url) return fail('no baseUrl configured');
    const out = await http(ctx, { url: joinUrl(url, '/api/tags') });
    return out.ok
      ? pass('Ollama answers')
      : fail(out.reason, 'Check the Ollama address and that it is running.');
  },

  'kubernetes.list-pods': async (ctx) => {
    const namespaces = list(ctx.component.settings['namespaces']);
    if (namespaces.length === 0) return skip('no namespaces configured');
    let client;
    try {
      client = ctx.kubernetes(ctx.secrets['kubeconfig']);
    } catch {
      return fail(
        'no usable kubeconfig',
        'Set the kubeconfig secret, or run the agent inside the cluster with its service account.',
      );
    }
    for (const ns of namespaces) {
      try {
        await client.listPods(ns, ctx.timeoutMs);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return fail(
          `namespace ${ns}: ${typeof code === 'number' ? `HTTP ${String(code)}` : 'could not connect'}`,
          code === 403
            ? 'The service account cannot list pods there. Apply rbac.yaml from the bundle.'
            : 'Check the cluster address and credentials.',
        );
      }
    }
    return pass(
      `can list pods in ${String(namespaces.length)} namespace${namespaces.length === 1 ? '' : 's'}`,
    );
  },

  'docker.ping': (ctx) => {
    const socketPath = str(ctx.component.settings['socketPath']) ?? '/var/run/docker.sock';
    return new Promise<ProbeResult>((resolve) => {
      const req = httpRequest(
        { socketPath, path: '/_ping', method: 'GET', timeout: ctx.timeoutMs },
        (res) => {
          res.resume();
          resolve(
            res.statusCode === 200
              ? pass('Docker answers')
              : fail(`HTTP ${String(res.statusCode)}`),
          );
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(fail('no answer from the Docker socket'));
      });
      req.on('error', () => {
        resolve(
          fail(
            'cannot reach the Docker socket',
            `Is ${socketPath} mounted into the agent container?`,
          ),
        );
      });
      req.end();
    });
  },

  'aws.get-caller-identity': (ctx) => {
    const region = str(ctx.component.settings['region']);
    if (!region) return Promise.resolve(fail('no region configured'));
    const id = ctx.secrets['accessKeyId'];
    const key = ctx.secrets['secretAccessKey'];
    return awsIdentity(
      ctx,
      region,
      id && key ? { accessKeyId: id, secretAccessKey: key } : undefined,
    );
  },

  'bedrock.get-caller-identity': (ctx) => {
    const region = str(ctx.component.settings['region']);
    return region
      ? awsIdentity(ctx, region, undefined)
      : Promise.resolve(fail('no region configured'));
  },
};

/**
 * STS GetCallerIdentity needs no IAM permission, so it only proves the credentials work.
 * Without explicit keys the SDK's default chain is used (environment, IRSA, profile).
 */
async function awsIdentity(
  ctx: ProbeContext,
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string } | undefined,
): Promise<ProbeResult> {
  const client = new STSClient({
    region,
    maxAttempts: 1,
    ...(credentials ? { credentials } : {}),
    ...(ctx.endpoints?.sts ? { endpoint: ctx.endpoints.sts } : {}),
  });
  try {
    const out = await client.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(ctx.timeoutMs),
    });
    return pass(`credentials work (account ${out.Account ?? 'unknown'})`);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'CredentialsProviderError') {
      return fail(
        'no AWS credentials found',
        'Set the AWS keys with `kodra-agent init`, or give the agent an IAM role (IRSA).',
      );
    }
    return fail(
      name === 'TimeoutError'
        ? `no answer within ${String(ctx.timeoutMs / 1000)}s`
        : `AWS says ${name || 'error'}`,
      'Check the credentials and region.',
    );
  } finally {
    client.destroy();
  }
}

async function slackCall(
  ctx: ProbeContext,
  method: string,
  token: string,
  what: string,
): Promise<ProbeResult> {
  const base = ctx.endpoints?.slack ?? 'https://slack.com';
  const out = await http(ctx, {
    url: joinUrl(base, `/api/${method}`),
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });
  if (!out.ok) return fail(out.reason);
  const body = out.json as { ok?: unknown; error?: unknown } | null;
  if (body?.ok === true) return pass(`${what} accepted`);
  const code = typeof body?.error === 'string' ? body.error : 'unknown error';
  return fail(`Slack says ${code}`, `Check the ${what} and its scopes.`);
}

/** The probe ids to run for a component: one per included secret, plus its health probe. */
export function probeIds(component: Component): string[] {
  const ids = new Set(component.secrets.map((s) => s.spec.probe));
  if (component.manifest.healthProbe) ids.add(component.manifest.healthProbe);
  return [...ids];
}

export async function runProbe(id: string, ctx: ProbeContext): Promise<ProbeResult> {
  const probe = probes[id];
  if (!probe) return skip(`no check for ${id}`);
  try {
    return await probe(ctx);
  } catch {
    return fail('the check failed unexpectedly');
  }
}
