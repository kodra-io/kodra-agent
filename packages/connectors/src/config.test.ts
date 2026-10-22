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
  it('has the documented examples, one per profile among them', () => {
    expect(examples.sort()).toEqual([
      'compose-basic.yaml',
      'kubernetes.yaml',
      'ollama-local.yaml',
      'starter.yaml',
      'strict.yaml',
      'team.yaml',
    ]);
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
    expect(dependencyIssues(['github-actions']).map((i) => i.message)).toEqual([
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

describe('profiles and environments', () => {
  // Without the file position, which the other tests cover.
  const plain = (result: ParseResult) =>
    messages(result).map((m) => m.replace(/^kodra-agent\.yaml:\d+:\d+ /, ''));
  const withEnvironments = (profile: string, environments: string, approvers = "['U01', 'U02']") =>
    `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  profile: ${profile}
  target: kubernetes
${ollama}  policy:
    approvals:
      approvers: ${approvers}
  environments:
${environments}
`;

  it('defaults to the starter profile with no environments', () => {
    const result = parseAgentConfig(config(ollama));
    expect(result.ok && [result.config.spec.profile, result.config.spec.environments]).toEqual([
      'starter',
      [],
    ]);
  });

  it('accepts environments with their own approvers and rules', () => {
    const result = parseAgentConfig(
      withEnvironments(
        'team',
        `    - name: production
      production: true
      namespaces: [checkout, payments]
      repos: [acme/checkout-api]
      approvers: ['U01', 'U02', 'console:omar']
      approvals: {minApprovers: 1, allowSelfApproval: false}
    - name: staging
      namespaces: [staging]`,
      ),
    );
    expect(result.ok ? [] : messages(result)).toEqual([]);
    expect(result.ok && result.config.spec.environments[1]).toEqual({
      name: 'staging',
      production: false,
      namespaces: ['staging'],
      repos: [],
      approvals: {},
      freezes: [],
    });
  });

  it('refuses production rules nobody can satisfy, with a readable message', () => {
    const result = parseAgentConfig(
      withEnvironments(
        'team',
        `    - name: production
      production: true
      namespaces: [shop]`,
        "['U01']",
      ),
    );
    expect(plain(result)).toEqual([
      'spec.environments.0.approvers: Production changes need someone other than the requester. Add a second approver.',
    ]);
  });

  it('refuses an unknown profile and a bad namespace or repo', () => {
    const text = withEnvironments(
      'enterprise',
      `    - name: prod
      namespaces: [Shop]
      repos: [checkout]`,
    );
    expect(plain(parseAgentConfig(text)).join('\n')).toEqual(
      [
        'spec.profile: must be starter, team, or strict',
        'spec.environments.0.namespaces.0: must be a Kubernetes namespace: lowercase letters, digits, and hyphens',
        'spec.environments.0.repos.0: must be a repository like owner/repo, or a GitLab project like group/project',
      ].join('\n'),
    );
  });

  it('needs the console for console approvers in an environment', () => {
    const text = withEnvironments(
      'starter',
      `    - name: prod
      namespaces: [shop]
      approvers: ['console:omar']`,
    ).replace('spec:\n', 'spec:\n  console: {enabled: false}\n');
    expect(plain(parseAgentConfig(text))).toContain(
      'spec.console.enabled: console approvers need the console: set spec.console.enabled to true.',
    );
  });
});

describe('change control', () => {
  const plain = (result: ParseResult) =>
    messages(result).map((m) => m.replace(/^kodra-agent\.yaml:\d+:\d+ /, ''));
  const withProduction = (extra: string) => `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  profile: team
  target: kubernetes
${ollama}  policy:
    approvals:
      approvers: ['U01', 'U02']
  environments:
    - name: production
      production: true
      namespaces: [shop]
${extra}
`;

  it('accepts freezes and change references', () => {
    const result = parseAgentConfig(
      withProduction(`      approvals: {requireChangeRef: true, changeRefPattern: '^CHG[0-9]{7}$'}
      freezes:
        - {name: weekend, timezone: Asia/Amman, weekly: {from: 'Thu 18:00', to: 'Sat 23:59'}}
        - {name: year-end, timezone: Asia/Amman, dates: {from: '2026-12-28', to: '2027-01-02'}}`),
    );
    expect(result.ok ? [] : plain(result)).toEqual([]);
  });

  it('refuses bad freezes and a bad pattern, with readable messages', () => {
    const result = parseAgentConfig(
      withProduction(`      approvals: {changeRefPattern: '([a-z'}
      freezes:
        - {name: a, timezone: Mars/Olympus, weekly: {from: 'Thursday 18:00', to: 'Sat 23:59'}}
        - {name: b, timezone: UTC, dates: {from: '2027-01-02', to: '2026-12-28'}}
        - {name: c, timezone: UTC}`),
    );
    expect(plain(result)).toEqual([
      'spec.environments.0.approvals.changeRefPattern: is not a valid regular expression',
      'spec.environments.0.freezes.0.timezone: must be a time zone like Asia/Amman or UTC',
      'spec.environments.0.freezes.0.weekly.from: must be a weekday and a time, like Thu 18:00',
      'spec.environments.0.freezes.1.dates: from must not be after to',
      'spec.environments.0.freezes.2: needs either weekly or dates, not both',
    ]);
  });
});

describe('data protection and named models', () => {
  const plain = (result: ParseResult) =>
    messages(result).map((m) => m.replace(/^kodra-agent\.yaml:\d+:\d+ /, ''));
  const withModels = (extra: string) => `${config(ollama)}  models:
    local:
      provider: ollama
      name: m
      baseUrl: http://ollama:11434
  environments:
    - name: production
      namespaces: [shop]
      model: ${extra}
  dataProtection:
    redact: [cards, emails]
    patterns:
      - {name: customer-id, regex: '\bCUST-[0-9]{8}\b'}
`;

  it('accepts named models, an environment that names one, and detectors', () => {
    const result = parseAgentConfig(withModels('local'));
    expect(result.ok ? [] : plain(result)).toEqual([]);
  });

  it('refuses an unknown model and patterns that match nothing or are invalid', () => {
    const bad = withModels('cloud').replace(
      "regex: '\bCUST-[0-9]{8}\b'}",
      "regex: '.*'}\n      - {name: broken, regex: '([a-z'}",
    );
    expect(plain(parseAgentConfig(bad))).toEqual([
      'spec.dataProtection.patterns.0.regex: must be a valid regular expression that does not match empty text',
      'spec.dataProtection.patterns.1.regex: must be a valid regular expression that does not match empty text',
      'spec.environments.0.model: cloud is not in spec.models. Name a model defined there.',
    ]);
  });
});

describe('databases: entries', () => {
  const databases = (entries: string) =>
    config(`${ollama}  connectors:
    databases:
      enabled: true
      config:
        databases:
${entries}`);

  it('takes databases with their own secret references, and tunnels', () => {
    const result = parseAgentConfig(
      databases(`          - name: orders
            engine: mariadb
            host: orders.abc123.eu-central-1.rds.amazonaws.com
            user: kodra_monitor
            password: \${env:KODRA_DB_ORDERS_PASSWORD}
          - name: billing-replica
            engine: postgres
            host: 10.0.4.12
            port: 6432
            user: kodra_monitor
            password: \${file:/secrets/billing-password}
            tunnelHost: bastion.example.com
            tunnelUser: tunnel
            tunnelHostKey: SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8
            tunnelKey: \${env:KODRA_DB_BILLING_REPLICA_TUNNEL_KEY}
`),
    );
    expect(result.ok ? [] : messages(result)).toEqual([]);
    if (!result.ok) return;
    const entries = result.config.spec.connectors['databases']?.config?.['databases'];
    // Defaults filled in: verify TLS, port 22 for the tunnel, the warning levels.
    expect(entries).toMatchObject([
      { name: 'orders', tls: 'verify', maxLagSeconds: 30, connectionsWarnPercent: 90 },
      { name: 'billing-replica', tunnelPort: 22 },
    ]);
  });

  it("never points a database's secret at another variable, like the model key", () => {
    const result = parseAgentConfig(
      databases(`          - name: orders
            engine: mysql
            host: db
            user: m
            password: \${env:ANTHROPIC_API_KEY}
`),
    );
    expect(messages(result).join('\n')).toContain('must be ${env:KODRA_DB_ORDERS_PASSWORD}');
  });

  it('refuses a plain password and an unknown engine, without echoing the value', () => {
    const result = parseAgentConfig(
      databases(`          - name: orders
            engine: oracle
            host: db
            user: m
            password: hunter2-plain # gitleaks:allow
`),
    );
    const text = messages(result).join('\n');
    expect(text).toContain('must be a secret reference, not a value');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('must be mariadb, mysql, postgres');
  });

  it('refuses a repeated name, and half a tunnel', () => {
    const result = parseAgentConfig(
      databases(`          - name: orders
            engine: mysql
            host: db
            user: m
          - name: orders
            engine: mysql
            host: db2
            user: m
            tunnelHost: bastion
`),
    );
    const text = messages(result).join('\n');
    expect(text).toContain('orders is used twice');
    expect(text).toContain('tunnelUser: is required with tunnelHost');
  });
});
