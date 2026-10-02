import { readdirSync, readFileSync } from 'node:fs';
import { formatIssue, type ParseResult } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { dependencyIssues, parseAgentConfig } from './index.ts';

const examplesDir = new URL('../../../examples/', import.meta.url);
const examples = readdirSync(examplesDir).filter((f) => f.endsWith('.yaml'));

function messages(result: ParseResult): string[] {
  if (result.ok) throw new Error('expected the config to be invalid');
  return result.issues.map((i) => formatIssue(i));
}

function config(spec: string): string {
  return `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  target: compose
${spec}
  policy:
    approvals:
      approvers: ['@omar']
`;
}

const ollama = `  model:
    provider: ollama
    name: m
    baseUrl: http://ollama:11434
`;

describe('examples', () => {
  it('has the three documented examples', () => {
    expect(examples.sort()).toEqual(['compose-basic.yaml', 'kubernetes.yaml', 'ollama-local.yaml']);
  });

  it.each(examples)('%s validates', (file) => {
    const result = parseAgentConfig(readFileSync(new URL(file, examplesDir), 'utf8'));
    expect(result.ok ? [] : messages(result)).toEqual([]);
  });
});

describe('model providers', () => {
  it.each([
    ['anthropic', 'apiKey: ${env:ANTHROPIC_API_KEY}'],
    ['anthropic', 'apiKey: ${env:ANTHROPIC_API_KEY}\n    baseUrl: https://gateway.internal'],
    ['openai', 'apiKey: ${env:OPENAI_API_KEY}'],
    [
      'azure-openai',
      'apiKey: ${env:AZURE_OPENAI_API_KEY}\n    endpoint: https://r.openai.azure.com\n    deployment: gpt',
    ],
    ['bedrock', 'region: us-east-1'],
    ['ollama', 'baseUrl: http://localhost:11434'],
  ])('accepts %s', (provider, fields) => {
    const result = parseAgentConfig(
      config(`  model:\n    provider: ${provider}\n    name: some-model\n    ${fields}\n`),
    );
    expect(result.ok ? [] : messages(result)).toEqual([]);
  });

  it.each([
    ['ollama without baseUrl', 'provider: ollama', 'spec.model.baseUrl: is required'],
    [
      'ollama with an apiKey',
      'provider: ollama\n    baseUrl: http://o:1\n    apiKey: ${env:K}',
      'unknown key apiKey',
    ],
    [
      'bedrock with an apiKey',
      'provider: bedrock\n    region: us-east-1\n    apiKey: ${env:K}',
      'apiKey',
    ],
    ['bedrock with a bad region', 'provider: bedrock\n    region: europe', 'must be an AWS region'],
    [
      'azure without endpoint',
      'provider: azure-openai\n    apiKey: ${env:K}\n    deployment: d',
      'endpoint: is required',
    ],
    ['an unknown provider', 'provider: mistral', 'provider must be one of anthropic, openai'],
    [
      'anthropic with a ftp baseUrl',
      'provider: anthropic\n    apiKey: ${env:K}\n    baseUrl: ftp://x',
      'http or https',
    ],
  ])('rejects %s', (_name, fields, expected) => {
    const result = parseAgentConfig(config(`  model:\n    name: m\n    ${fields}\n`));
    expect(messages(result).join('\n')).toContain(expected);
  });

  it('never repeats an API key pasted into the config', () => {
    const key = 'sk-ant-api03-ThisIsAPastedKeyThatMustNotLeak'; // gitleaks:allow (fake value)
    const result = parseAgentConfig(
      config(`  model:\n    provider: anthropic\n    name: m\n    apiKey: ${key}\n`),
    );
    const out = messages(result).join('\n');
    expect(out).toContain('spec.model.apiKey: must be a secret reference');
    expect(out).not.toContain(key);
  });
});

describe('connectors', () => {
  it('rejects an access level the connector does not offer', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:
    prometheus:
      enabled: true
      access: read-write-approved
      config:
        url: http://prom:9090`),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:14:7 spec.connectors.prometheus.access: must be read-only',
    ]);
  });

  it('rejects an access key on a connector without access levels', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:
    slack:
      enabled: true
      access: read-only
      config:
        channel: '#ops'
      secrets:
        botToken: \${env:SLACK_BOT_TOKEN}
        appToken: \${env:SLACK_APP_TOKEN}`),
    );
    expect(messages(result).join('\n')).toContain('unknown key access');
  });

  it('refuses to enable a coming-soon connector', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:\n    teams:\n      enabled: true`),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:13:7 spec.connectors.teams.enabled: Microsoft Teams is coming soon and cannot be enabled yet.',
    ]);
  });

  it('allows a coming-soon connector that stays disabled', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:\n    teams:\n      enabled: false`),
    );
    expect(result.ok).toBe(true);
  });

  it('validates connector-specific config with readable hints', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:
    kubernetes:
      enabled: true
      config:
        namespaces: [Payments]
    slack:
      enabled: true
      config:
        channel: payments-ops
      secrets:
        botToken: \${env:SLACK_BOT_TOKEN}
        appToken: \${env:SLACK_APP_TOKEN}`),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:15:22 spec.connectors.kubernetes.config.namespaces.0: use a Kubernetes namespace name: lowercase letters, digits, and hyphens',
      'kodra-agent.yaml:19:9 spec.connectors.slack.config.channel: start with #, like #payments-ops',
    ]);
  });

  it('rejects an unknown config field and names the allowed ones', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:
    prometheus:
      enabled: true
      config:
        url: http://prom:9090
        interval: 30`),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:16:9 spec.connectors.prometheus.config: unknown config field interval. Allowed: url, alertmanagerUrl, pollIntervalSeconds.',
    ]);
  });

  it('enforces integer bounds', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:
    prometheus:
      enabled: true
      config:
        url: http://prom:9090
        pollIntervalSeconds: 5`),
    );
    expect(messages(result).join('\n')).toContain('pollIntervalSeconds');
  });
});

describe('dependency rules', () => {
  it('flags CI/CD connectors whose source connector is off', () => {
    expect(dependencyIssues(['github-actions']).map((i) => i.message.en)).toEqual([
      'GitHub Actions needs the GitHub connector, because it uses the same token.',
    ]);
    expect(dependencyIssues(['gitlab-ci']).map((i) => i.connector)).toEqual(['gitlab-ci']);
  });

  it('does not accept the wrong source connector', () => {
    expect(dependencyIssues(['github-actions', 'gitlab']).map((i) => i.connector)).toEqual([
      'github-actions',
    ]);
  });

  it('passes when the source connector is on', () => {
    expect(dependencyIssues(['github-actions', 'github'])).toEqual([]);
    expect(dependencyIssues(['gitlab-ci', 'gitlab'])).toEqual([]);
  });

  it('gives Arabic messages too', () => {
    expect(dependencyIssues(['gitlab-ci'])[0]?.message.ar).toMatch(/[؀-ۿ]/);
  });

  it('reports the rule in the parsed config', () => {
    const result = parseAgentConfig(
      config(`${ollama}  connectors:\n    github-actions:\n      enabled: true`),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:13:7 spec.connectors.github-actions.enabled: GitHub Actions needs the GitHub connector, because it uses the same token.',
    ]);
  });
});

describe('policy', () => {
  const withPolicy = (policy: string) =>
    `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  target: compose
${ollama}  policy:
${policy}
`;

  it('refuses to turn approvals off', () => {
    const result = parseAgentConfig(
      withPolicy("    approvals:\n      required: false\n      approvers: ['@omar']"),
    );
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:13:7 spec.policy.approvals.required: approvals cannot be turned off in kodra.io/v1alpha1. Every write needs a human approval.',
    ]);
  });

  it('needs at least one approver in a valid format', () => {
    const empty = parseAgentConfig(withPolicy('    approvals:\n      approvers: []'));
    expect(messages(empty).join('\n')).toContain('needs at least one approver');
    const bad = parseAgentConfig(withPolicy("    approvals:\n      approvers: ['omar']"));
    expect(messages(bad).join('\n')).toContain('must be a Slack handle like @omar');
  });

  it('accepts require-approval for destructive actions', () => {
    const result = parseAgentConfig(
      withPolicy(
        "    approvals:\n      approvers: ['U0123ABCD']\n    destructiveActions: require-approval",
      ),
    );
    expect(result.ok && result.config.spec.policy.destructiveActions).toBe('require-approval');
  });

  it('rejects other destructiveActions values', () => {
    const result = parseAgentConfig(
      withPolicy("    approvals:\n      approvers: ['@a']\n    destructiveActions: allow"),
    );
    expect(messages(result).join('\n')).toContain('must be deny or require-approval');
  });

  it('bounds approval expiry', () => {
    const result = parseAgentConfig(
      withPolicy("    approvals:\n      approvers: ['@a']\n      expiresAfterMinutes: 0"),
    );
    expect(messages(result).join('\n')).toContain('expiresAfterMinutes');
  });
});

describe('metadata', () => {
  it.each(['Payments', 'payments_agent', '-agent', 'a'.repeat(54)])('rejects name %s', (name) => {
    const text = config(ollama).replace('name: test-agent', `name: ${name}`);
    expect(messages(parseAgentConfig(text)).join('\n')).toContain('metadata.name');
  });
});
