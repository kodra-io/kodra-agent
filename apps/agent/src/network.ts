import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { parseSecretRef, type AgentConfig } from '@kodra-agent/schema';
import type { Redactor } from './redactor.ts';

/**
 * Proxies and private CAs (PLAN-v0.2 M12). The agent applies them to its own process at
 * startup (Node 24.14+: http.setGlobalProxyFromEnv for fetch and http(s), and
 * tls.setDefaultCACertificates for every TLS client), and passes the same settings to every
 * MCP server, git, helm, and docker as environment variables, in the forms each one reads.
 */

/** Always skips the proxy: this machine, and in-cluster names. */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '.svc', '.cluster.local'];

export interface NetworkSettings {
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string;
  caFile: string | null;
  /** References in the config whose variable is not set, for doctor. */
  missing: string[];
}

/** The network settings, with proxy references resolved from the environment. */
export function networkSettings(
  config: AgentConfig,
  env: Readonly<Record<string, string | undefined>>,
): NetworkSettings {
  const missing: string[] = [];
  const read = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const ref = parseSecretRef(raw);
    if (!ref.ok || ref.ref.scheme !== 'env') return null;
    const value = env[ref.ref.name];
    if (!value) missing.push(ref.ref.name);
    return value || null;
  };
  const proxy = config.spec.network.proxy;
  const httpsProxy = read(proxy?.https);
  const httpProxy = read(proxy?.http);
  // The API server is reached directly, by its address, from inside the cluster.
  const apiServer = env['KUBERNETES_SERVICE_HOST'];
  const noProxy = [
    ...new Set([
      ...ALWAYS_DIRECT,
      ...(apiServer ? [apiServer] : []),
      ...(proxy?.noProxy ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ].join(',');
  return {
    httpsProxy,
    httpProxy,
    noProxy,
    caFile: config.spec.network.caBundleFile ?? null,
    missing,
  };
}

/** Certificates in a PEM file; an error names the file, never its contents. */
export function pemCertificates(text: string): string[] {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map(
    (m) => `${m[0]}\n`,
  );
}

export interface NetworkRuntime {
  setGlobalProxyFromEnv?: ((env: Record<string, string>) => unknown) | undefined;
  setDefaultCACertificates?: ((certs: string[]) => void) | undefined;
  getDefaultCACertificates?: (() => string[]) | undefined;
}

const nodeRuntime = (): NetworkRuntime => {
  const h = http as unknown as NetworkRuntime;
  const t = tls as unknown as {
    setDefaultCACertificates?: (certs: string[]) => void;
    getCACertificates?: (type?: string) => string[];
  };
  return {
    setGlobalProxyFromEnv: h.setGlobalProxyFromEnv,
    setDefaultCACertificates: t.setDefaultCACertificates,
    getDefaultCACertificates: t.getCACertificates
      ? () => t.getCACertificates?.('default') ?? []
      : undefined,
  };
};

export interface AppliedNetwork {
  /** For child processes: proxy variables in both cases, and CA files in each tool's form. */
  childEnv: Record<string, string>;
  /** What could not be applied to this process, in words for the person running it. */
  problems: string[];
}

/**
 * Applies the settings to this process and returns the environment for child processes.
 * A combined CA file (the default roots plus the extra ones) is written for Go, Python,
 * curl, and git, which replace the system roots when pointed at a file rather than adding to
 * them. Node children get the extra file alone, which Node adds to its roots.
 */
export async function applyNetwork(
  settings: NetworkSettings,
  redactor: Redactor,
  runtime: NetworkRuntime = nodeRuntime(),
): Promise<AppliedNetwork> {
  const childEnv: Record<string, string> = {};
  const problems: string[] = [];
  for (const value of [settings.httpsProxy, settings.httpProxy]) if (value) redactor.add(value);

  if (settings.httpsProxy || settings.httpProxy) {
    const proxyEnv: Record<string, string> = { NO_PROXY: settings.noProxy };
    if (settings.httpsProxy) proxyEnv['HTTPS_PROXY'] = settings.httpsProxy;
    if (settings.httpProxy) proxyEnv['HTTP_PROXY'] = settings.httpProxy;
    for (const [name, value] of Object.entries(proxyEnv)) {
      childEnv[name] = value;
      // curl (and so git) reads only the lower-case http_proxy.
      childEnv[name.toLowerCase()] = value;
    }
    childEnv['NODE_USE_ENV_PROXY'] = '1';
    if (runtime.setGlobalProxyFromEnv) runtime.setGlobalProxyFromEnv(proxyEnv);
    else problems.push('this Node.js cannot use a proxy (needs 24.14 or newer; the image has it)');
  }

  if (settings.caFile) {
    let extra: string[] = [];
    try {
      extra = pemCertificates(await readFile(settings.caFile, 'utf8'));
      if (extra.length === 0) problems.push(`${settings.caFile} holds no PEM certificates`);
    } catch {
      problems.push(`cannot read the CA file ${settings.caFile}`);
    }
    if (extra.length > 0) {
      // Node returns them without a trailing newline: joined as they are, one certificate's
      // END line runs into the next one's BEGIN, and Go and Python cannot read the file.
      const roots = (runtime.getDefaultCACertificates?.() ?? [...tls.rootCertificates]).map((c) =>
        c.endsWith('\n') ? c : `${c}\n`,
      );
      if (!runtime.setDefaultCACertificates) {
        problems.push(
          'this Node.js cannot add CA certificates (needs 24.5 or newer; the image has it)',
        );
      } else {
        try {
          runtime.setDefaultCACertificates([...roots, ...extra]);
        } catch {
          problems.push(`${settings.caFile} holds a certificate that cannot be read`);
        }
      }
      const dir = await mkdtemp(join(tmpdir(), 'kodra-ca-'));
      const combined = join(dir, 'ca-bundle.pem');
      await writeFile(combined, [...roots, ...extra].join(''), { mode: 0o644 });
      childEnv['NODE_EXTRA_CA_CERTS'] = settings.caFile;
      for (const name of [
        'SSL_CERT_FILE',
        'REQUESTS_CA_BUNDLE',
        'AWS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'GIT_SSL_CAINFO',
      ]) {
        childEnv[name] = combined;
      }
    }
  }
  return { childEnv, problems };
}

/** The proxy for clients that bring their own HTTP stack (Slack's Socket Mode WebSocket). */
export function proxyOptions(
  settings: NetworkSettings,
): { httpsProxy?: string; httpProxy?: string; noProxy: string } | null {
  if (!settings.httpsProxy && !settings.httpProxy) return null;
  return {
    ...(settings.httpsProxy ? { httpsProxy: settings.httpsProxy } : {}),
    ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
    noProxy: settings.noProxy,
  };
}

/** A runtime that changes nothing in this process, for tests. */
export const NO_NETWORK_RUNTIME: NetworkRuntime = {
  setGlobalProxyFromEnv: () => undefined,
  setDefaultCACertificates: () => undefined,
  getDefaultCACertificates: () => [],
};
