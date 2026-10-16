import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { applyNetwork, networkSettings, pemCertificates, type NetworkRuntime } from './network.ts';
import { Redactor } from './redactor.ts';
import { configYaml, tempDir } from './test-helpers.ts';

const CERT = (n: string) => `-----BEGIN CERTIFICATE-----\nMII${n}\n-----END CERTIFICATE-----`;

function config(network: string) {
  const result = parseAgentConfig(
    `${configYaml({ auditPath: '/tmp/a.jsonl' })}  network:\n${network}`,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

/** A Node.js runtime that records what the agent applies to its own process. */
function recording(): NetworkRuntime & { proxy: Record<string, string>[]; cas: string[][] } {
  const proxy: Record<string, string>[] = [];
  const cas: string[][] = [];
  return {
    proxy,
    cas,
    setGlobalProxyFromEnv: (env) => proxy.push(env),
    setDefaultCACertificates: (certs) => cas.push(certs),
    getDefaultCACertificates: () => [`${CERT('ROOT')}\n`],
  };
}

describe('networkSettings', () => {
  it('reads the proxy from the environment and adds the in-cluster names', () => {
    const settings = networkSettings(
      config(
        "    proxy:\n      https: '${env:HTTPS_PROXY}'\n      http: '${env:CORP_HTTP}'\n      noProxy: 'git.internal, .corp'",
      ),
      {
        HTTPS_PROXY: 'http://user:s3cret-proxy-pass@proxy.corp:3128',
        KUBERNETES_SERVICE_HOST: '10.96.0.1',
      },
    );
    expect(settings).toEqual({
      httpsProxy: 'http://user:s3cret-proxy-pass@proxy.corp:3128',
      httpProxy: null,
      noProxy: 'localhost,127.0.0.1,::1,.svc,.cluster.local,10.96.0.1,git.internal,.corp',
      caFile: null,
      missing: ['CORP_HTTP'],
    });
  });

  it('is empty without a network section', () => {
    expect(networkSettings(config('    {}'), {})).toMatchObject({
      httpsProxy: null,
      httpProxy: null,
      caFile: null,
      missing: [],
    });
  });
});

describe('applyNetwork', () => {
  it('applies the proxy to this process and gives children both cases, never logging the password', async () => {
    const redactor = new Redactor();
    const runtime = recording();
    const applied = await applyNetwork(
      {
        httpsProxy: 'http://user:s3cret-proxy-pass@proxy.corp:3128',
        httpProxy: null,
        noProxy: 'localhost,.svc',
        caFile: null,
        missing: [],
      },
      redactor,
      runtime,
    );
    expect(runtime.proxy).toEqual([
      { NO_PROXY: 'localhost,.svc', HTTPS_PROXY: 'http://user:s3cret-proxy-pass@proxy.corp:3128' },
    ]);
    expect(applied.childEnv).toEqual({
      NO_PROXY: 'localhost,.svc',
      no_proxy: 'localhost,.svc',
      HTTPS_PROXY: 'http://user:s3cret-proxy-pass@proxy.corp:3128',
      https_proxy: 'http://user:s3cret-proxy-pass@proxy.corp:3128',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(applied.problems).toEqual([]);
    expect(redactor.redact('via http://user:s3cret-proxy-pass@proxy.corp:3128')).not.toContain(
      's3cret-proxy-pass',
    );
  });

  it('adds the extra CAs to this process, and writes a combined file for Go, Python, and git', async () => {
    const dir = await tempDir();
    const caFile = join(dir, 'ca.pem');
    await writeFile(caFile, `${CERT('CORP')}\nnot a cert\n`);
    const runtime = recording();
    const applied = await applyNetwork(
      { httpsProxy: null, httpProxy: null, noProxy: '', caFile, missing: [] },
      new Redactor(),
      runtime,
    );
    expect(runtime.cas).toEqual([[`${CERT('ROOT')}\n`, `${CERT('CORP')}\n`]]);
    expect(applied.childEnv['NODE_EXTRA_CA_CERTS']).toBe(caFile);
    const combined = applied.childEnv['SSL_CERT_FILE'] ?? '';
    expect(await readFile(combined, 'utf8')).toBe(`${CERT('ROOT')}\n${CERT('CORP')}\n`);
    for (const name of [
      'REQUESTS_CA_BUNDLE',
      'AWS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
    ]) {
      expect(applied.childEnv[name]).toBe(combined);
    }
  });

  it('says what it could not apply', async () => {
    const applied = await applyNetwork(
      {
        httpsProxy: 'http://proxy:3128',
        httpProxy: null,
        noProxy: '',
        caFile: '/nowhere/ca.pem',
        missing: [],
      },
      new Redactor(),
      {},
    );
    expect(applied.problems).toEqual([
      'this Node.js cannot use a proxy (needs 24.14 or newer; the image has it)',
      'cannot read the CA file /nowhere/ca.pem',
    ]);
  });

  it('finds every certificate in a PEM file', () => {
    expect(pemCertificates(`junk\n${CERT('A')}\n${CERT('B')}`)).toHaveLength(2);
    expect(pemCertificates('nothing here')).toEqual([]);
  });
});
