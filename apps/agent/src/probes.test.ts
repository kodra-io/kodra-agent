import { connectors, modelProviders, parseAgentConfig } from '@kodra-agent/connectors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { components, type Component } from './config.ts';
import { probeIds, probes, runProbe, type ProbeContext } from './probes.ts';
import { fakeKubernetes, fakeServer, json } from './test-helpers.ts';

type Server = Awaited<ReturnType<typeof fakeServer>>;
let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function componentsFor(model: string, rawConnectors = '    {}'): Component[] {
  // Secret references must be quoted inside YAML flow maps.
  const connectorsYaml = rawConnectors.replace(/(?<!')(\$\{[^}]+\})(?!')/g, "'$1'");
  const result = parseAgentConfig(`apiVersion: kodra.io/v1alpha1
kind: Agent
metadata: {name: t}
spec:
  target: compose
  model:
${model}
  connectors:
${connectorsYaml}
  policy: {approvals: {approvers: ['@a']}}
`);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return components(result.config);
}

function byId(list: Component[], id: string): Component {
  const found = list.find((c) => c.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

function ctxFor(
  component: Component,
  secrets: Record<string, string>,
  extra: Partial<ProbeContext> = {},
): ProbeContext {
  return {
    component,
    secrets,
    fetch: globalThis.fetch,
    kubernetes: fakeKubernetes(),
    timeoutMs: 2000,
    ...extra,
  };
}

const ollama = (url: string) => `    provider: ollama\n    name: m\n    baseUrl: ${url}`;

describe('probe coverage', () => {
  it('implements every probe id the manifests name', () => {
    const ids = new Set<string>();
    for (const m of [...connectors, ...modelProviders]) {
      for (const s of m.secrets) ids.add(s.probe);
      if (m.healthProbe) ids.add(m.healthProbe);
    }
    expect([...ids].filter((id) => !(id in probes))).toEqual([]);
  });
});

describe('GitHub', () => {
  it('reads each configured repo with a Bearer token', async () => {
    server = await fakeServer({
      '/repos/acme/api': (_q, s) => {
        json(s, 200, { id: 1 });
      },
      '/repos/acme/web': (_q, s) => {
        json(s, 200, { id: 2 });
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        `    github:\n      enabled: true\n      config: {repos: [acme/api, acme/web]}\n      secrets: {token: \${env:GITHUB_TOKEN}}`,
      ),
      'github',
    );
    const result = await runProbe(
      'github.read-repos',
      ctxFor(comp, { token: 'gh-test-token' }, { endpoints: { github: server.url } }),
    );
    expect(result).toEqual({ status: 'pass', message: 'can read 2 repos' });
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer gh-test-token',
      'Bearer gh-test-token',
    ]);
  });

  it('names the repo that failed and explains a 404', async () => {
    server = await fakeServer({
      '/repos/acme/api': (_q, s) => {
        json(s, 404, {});
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        `    github:\n      enabled: true\n      config: {repos: [acme/api]}\n      secrets: {token: \${env:GITHUB_TOKEN}}`,
      ),
      'github',
    );
    expect(
      await runProbe(
        'github.read-repos',
        ctxFor(comp, { token: 't' }, { endpoints: { github: server.url } }),
      ),
    ).toEqual({
      status: 'fail',
      message: 'repo acme/api: HTTP 404',
      hint: 'Not found, or the token cannot see it.',
    });
  });
});

describe('GitLab', () => {
  it('reads each project by its URL-encoded path with PRIVATE-TOKEN', async () => {
    server = await fakeServer({
      '/api/v4/projects/acme%2Fplatform%2Fapi': (_q, s) => {
        json(s, 200, { id: 1 });
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        `    gitlab:\n      enabled: true\n      config: {url: 'URL', projects: [acme/platform/api]}\n      secrets: {token: \${env:GITLAB_TOKEN}}`.replace(
          'URL',
          'http://127.0.0.1:1',
        ),
      ),
      'gitlab',
    );
    comp.settings['url'] = server.url;
    const result = await runProbe('gitlab.read-projects', ctxFor(comp, { token: 'gl-token' }));
    expect(result.status).toBe('pass');
    expect(server.requests[0]?.headers['private-token']).toBe('gl-token');
  });
});

describe('Slack', () => {
  it('checks the bot token with auth.test and the app token with apps.connections.open', async () => {
    server = await fakeServer({
      'POST /api/auth.test': (q, s) => {
        json(s, 200, { ok: q.headers.authorization === 'Bearer bot-token' });
      },
      'POST /api/apps.connections.open': (_q, s) => {
        json(s, 200, { ok: false, error: 'invalid_auth' });
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        "    slack:\n      enabled: true\n      config: {channel: '#ops'}\n      secrets: {botToken: ${env:SLACK_BOT_TOKEN}, appToken: ${env:SLACK_APP_TOKEN}}",
      ),
      'slack',
    );
    const ctx = ctxFor(
      comp,
      { botToken: 'bot-token', appToken: 'app-token' },
      { endpoints: { slack: server.url } },
    );
    expect(await runProbe('slack.auth-test', ctx)).toEqual({
      status: 'pass',
      message: 'bot token accepted',
    });
    expect(await runProbe('slack.open-socket-connection', ctx)).toEqual({
      status: 'fail',
      message: 'Slack says invalid_auth',
      hint: 'Check the app token and its scopes.',
    });
  });
});

describe('model providers', () => {
  it('Anthropic sends x-api-key and anthropic-version', async () => {
    server = await fakeServer({
      '/v1/models': (_q, s) => {
        json(s, 200, { data: [] });
      },
    });
    const comp = byId(
      componentsFor('    provider: anthropic\n    name: m\n    apiKey: ${env:ANTHROPIC_API_KEY}'),
      'anthropic',
    );
    expect(
      await runProbe(
        'anthropic.list-models',
        ctxFor(comp, { apiKey: 'ak' }, { endpoints: { anthropic: server.url } }),
      ),
    ).toEqual({
      status: 'pass',
      message: 'API key accepted',
    });
    expect(server.requests[0]?.headers['x-api-key']).toBe('ak');
    expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('OpenAI uses a configured baseUrl and explains a 401', async () => {
    server = await fakeServer({
      '/v1/models': (_q, s) => {
        json(s, 401, {});
      },
    });
    const comp = byId(
      componentsFor(
        `    provider: openai\n    name: m\n    apiKey: \${env:OPENAI_API_KEY}\n    baseUrl: http://127.0.0.1:1`,
      ),
      'openai',
    );
    comp.settings['baseUrl'] = server.url;
    expect(await runProbe('openai.list-models', ctxFor(comp, { apiKey: 'k' }))).toEqual({
      status: 'fail',
      message: 'HTTP 401',
      hint: 'The API key was rejected. Check it, or run `kodra-agent init` again.',
    });
  });

  it('Azure OpenAI lists models on the v1 API with the api-key header', async () => {
    server = await fakeServer({
      '/openai/v1/models': (_q, s) => {
        json(s, 200, { data: [] });
      },
    });
    const comp = byId(
      componentsFor(
        '    provider: azure-openai\n    name: m\n    apiKey: ${env:AZURE_OPENAI_API_KEY}\n    endpoint: http://127.0.0.1:1\n    deployment: d',
      ),
      'azure-openai',
    );
    comp.settings['endpoint'] = server.url;
    expect(
      (await runProbe('azure-openai.list-models', ctxFor(comp, { apiKey: 'az' }))).status,
    ).toBe('pass');
    expect(server.requests[0]?.headers['api-key']).toBe('az');
  });

  it('Ollama answers on /api/tags', async () => {
    server = await fakeServer({
      '/api/tags': (_q, s) => {
        json(s, 200, { models: [] });
      },
    });
    const comp = byId(componentsFor(ollama('http://127.0.0.1:1')), 'ollama');
    comp.settings['baseUrl'] = server.url;
    expect(await runProbe('ollama.list-models', ctxFor(comp, {}))).toEqual({
      status: 'pass',
      message: 'Ollama answers',
    });
  });

  it('Bedrock and AWS check credentials with STS GetCallerIdentity', async () => {
    server = await fakeServer({
      'POST /': (_q, s) => {
        s.writeHead(200, { 'content-type': 'text/xml' });
        s.end(
          '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/x</Arn><UserId>X</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
        );
      },
    });
    const bedrock = byId(
      componentsFor('    provider: bedrock\n    name: m\n    region: eu-central-1'),
      'bedrock',
    );
    const aws = byId(
      componentsFor(
        ollama('http://o:1'),
        '    aws:\n      enabled: true\n      config: {region: eu-central-1}',
      ),
      'aws',
    );
    const keys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-test-secret-key' };
    // Bedrock uses the default credential chain; pin it to fake keys, never real local ones.
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-test-secret-key');
    vi.stubEnv('AWS_PROFILE', '');
    const probesToRun = [
      ['bedrock.get-caller-identity', bedrock],
      ['aws.get-caller-identity', aws],
    ] as const;
    for (const [id, comp] of probesToRun) {
      const ctx = ctxFor(comp, keys, { endpoints: { sts: server.url } });
      expect(await runProbe(id, ctx)).toEqual({
        status: 'pass',
        message: 'credentials work (account 123456789012)',
      });
    }
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      expect.stringContaining('Credential=AKIDEXAMPLE/'),
      expect.stringContaining('Credential=AKIDEXAMPLE/'),
    ]);
    vi.unstubAllEnvs();
  });
});

describe('monitoring', () => {
  it('Prometheus needs a successful query, with the optional token', async () => {
    server = await fakeServer({
      '/api/v1/query': (_q, s) => {
        json(s, 200, { status: 'success', data: {} });
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        '    prometheus:\n      enabled: true\n      config: {url: http://127.0.0.1:1}',
      ),
      'prometheus',
    );
    comp.settings['url'] = server.url;
    expect(await runProbe('prometheus.query-up', ctxFor(comp, { bearerToken: 'pt' }))).toEqual({
      status: 'pass',
      message: 'query API answers',
    });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer pt');
    expect(server.requests[0]?.url).toBe('/api/v1/query?query=up');
  });

  it('Prometheus reports an unreachable address', async () => {
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        '    prometheus:\n      enabled: true\n      config: {url: http://127.0.0.1:1}',
      ),
      'prometheus',
    );
    expect(await runProbe('prometheus.query-up', ctxFor(comp, {}))).toEqual({
      status: 'fail',
      message: 'could not connect',
      hint: 'Check the Prometheus address.',
    });
  });

  it('Grafana reads the current org with the service account token', async () => {
    server = await fakeServer({
      '/api/org/': (_q, s) => {
        json(s, 200, { id: 1 });
      },
    });
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        '    grafana:\n      enabled: true\n      config: {url: http://127.0.0.1:1}\n      secrets: {serviceAccountToken: ${env:GRAFANA_TOKEN}}',
      ),
      'grafana',
    );
    comp.settings['url'] = server.url;
    expect(
      (await runProbe('grafana.get-current-org', ctxFor(comp, { serviceAccountToken: 'gt' })))
        .status,
    ).toBe('pass');
    expect(server.requests[0]?.headers.authorization).toBe('Bearer gt');
  });
});

describe('Kubernetes', () => {
  const k8sYaml =
    "    kubernetes:\n      enabled: true\n      config: {namespaces: [api, web]}\n      secrets: {kubeconfig: '${file:/secrets/kubeconfig}'}";

  it('lists pods in every namespace with the given kubeconfig', async () => {
    const k8s = fakeKubernetes();
    const comp = byId(componentsFor(ollama('http://o:1'), k8sYaml), 'kubernetes');
    expect(
      await runProbe(
        'kubernetes.list-pods',
        ctxFor(comp, { kubeconfig: 'kc' }, { kubernetes: k8s }),
      ),
    ).toEqual({
      status: 'pass',
      message: 'can list pods in 2 namespaces',
    });
    expect(k8s.calls.map((c) => [c.kubeconfig, c.args[0]])).toEqual([
      ['kc', 'api'],
      ['kc', 'web'],
    ]);
  });

  it('explains a 403 as missing RBAC', async () => {
    const k8s = fakeKubernetes({
      listPods: () => Promise.reject(Object.assign(new Error('forbidden'), { code: 403 })),
    });
    const comp = byId(componentsFor(ollama('http://o:1'), k8sYaml), 'kubernetes');
    expect(await runProbe('kubernetes.list-pods', ctxFor(comp, {}, { kubernetes: k8s }))).toEqual({
      status: 'fail',
      message: 'namespace api: HTTP 403',
      hint: 'The service account cannot list pods there. Apply rbac.yaml from the bundle.',
    });
  });
});

describe('probeIds', () => {
  it('runs one probe per secret plus the health probe, without duplicates', () => {
    const comp = byId(
      componentsFor(
        ollama('http://o:1'),
        '    prometheus:\n      enabled: true\n      config: {url: http://p:9090}\n      secrets: {bearerToken: ${env:PROMETHEUS_TOKEN}}',
      ),
      'prometheus',
    );
    expect(probeIds(comp)).toEqual(['prometheus.query-up']);
  });

  it('never lets a probe throw', async () => {
    const comp = byId(componentsFor(ollama('http://o:1')), 'ollama');
    const ctx = ctxFor(comp, {}, { fetch: () => Promise.reject(new Error('boom')) });
    expect(await runProbe('ollama.list-models', ctx)).toEqual({
      status: 'fail',
      message: 'could not connect',
      hint: 'Check the Ollama address and that it is running.',
    });
  });
});
