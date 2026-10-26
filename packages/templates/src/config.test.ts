import { parseAgentConfig } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { configYaml, effectivePolicy, validateDraft } from './config.ts';
import { emptyDraft, withConsoleAdmin } from './draft.ts';
import { composeDraft, kubernetesDraft, withConnector } from './test-drafts.ts';

const codes = (issues: ReturnType<typeof validateDraft>) =>
  issues.map((i) => `${i.field}:${i.code}`);

describe('validateDraft', () => {
  it('lists what an empty draft is missing', () => {
    expect(codes(validateDraft(emptyDraft()))).toEqual(['name:required', 'model.name:required']);
    // The console admin approves by default; a list emptied by hand is still required.
    expect(emptyDraft().policy.approvers).toBe('console:admin');
    const none = emptyDraft();
    none.policy.approvers = '';
    expect(codes(validateDraft(none))).toContain('policy.approvers:required');
  });

  it('adds console:admin with the console and takes it out without it', () => {
    expect(withConsoleAdmin('@omar', true)).toBe('console:admin, @omar');
    expect(withConsoleAdmin('console:admin, @omar', true)).toBe('console:admin, @omar');
    expect(withConsoleAdmin('console:admin, @omar', false)).toBe('@omar');
    expect(withConsoleAdmin('@omar', false)).toBe('@omar');
  });

  it.each([
    ['the spec example', composeDraft()],
    ['a kubernetes draft', kubernetesDraft()],
    ['a read-write kubernetes draft', kubernetesDraft('read-write-approved')],
  ])('accepts %s, and its YAML passes the real schema', (_name, draft) => {
    expect(validateDraft(draft)).toEqual([]);
    const result = parseAgentConfig(configYaml(draft));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('checks the agent name format', () => {
    expect(codes(validateDraft({ ...composeDraft(), name: 'Payments Agent' }))).toEqual([
      'name:name-format',
    ]);
  });

  it('checks connector fields with the manifest hint', () => {
    const draft = withConnector(composeDraft(), 'github', { config: { repos: 'acme' } });
    const [issue] = validateDraft(draft);
    expect(issue).toMatchObject({
      field: 'connector.github.repos',
      step: 'connectors',
      code: 'pattern',
    });
    expect(issue?.code === 'pattern' && issue.hint).toBe('use owner/repo, like acme/payments-api');
  });

  it('checks URLs and integer ranges', () => {
    let draft = withConnector(composeDraft(), 'prometheus', {
      config: { url: 'prometheus:9090', pollIntervalSeconds: '5' },
    });
    expect(codes(validateDraft(draft))).toEqual([
      'connector.prometheus.url:url',
      'connector.prometheus.pollIntervalSeconds:integer-range',
    ]);
    draft = withConnector(composeDraft(), 'prometheus', {
      config: { url: 'http://p:9090', pollIntervalSeconds: '' },
    });
    expect(validateDraft(draft)).toEqual([]);
  });

  it('reports dependency rules on the connector', () => {
    const draft = withConnector(composeDraft(), 'gitlab-ci');
    expect(validateDraft(draft)).toEqual([
      expect.objectContaining({ field: 'connector.gitlab-ci', code: 'dependency' }),
    ]);
  });

  it('starts with every connector off, preview ones included', () => {
    expect(emptyDraft().connectors).toEqual({});
  });

  it('accepts a preview connector the user turned on, and its config loads', () => {
    const draft = withConnector(composeDraft(), 'docker');
    expect(validateDraft(draft)).toEqual([]);
    const result = parseAgentConfig(configYaml(draft));
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) expect(result.config.spec.connectors['docker']?.enabled).toBe(true);
  });

  it('blocks a coming-soon connector that came in through a crafted draft', () => {
    const draft = composeDraft();
    draft.connectors['teams'] = {
      enabled: true,
      access: 'read-only',
      config: {},
      optionalSecrets: [],
    };
    expect(codes(validateDraft(draft))).toContain('connector.teams:coming-soon');
  });

  it('checks approvers and expiry', () => {
    const draft = {
      ...composeDraft(),
      policy: {
        approvers: '@omar, omar',
        expiresAfterMinutes: '0',
        destructiveActions: 'deny' as const,
      },
    };
    expect(codes(validateDraft(draft))).toEqual([
      'policy.approvers:approver-format',
      'policy.expiresAfterMinutes:integer-range',
    ]);
  });

  it('accepts console approvers, which need the console, and writes chat', () => {
    const draft = {
      ...composeDraft(),
      policy: { ...composeDraft().policy, approvers: '@omar, console:on-call' },
      console: { enabled: true, chat: false },
    };
    expect(validateDraft(draft)).toEqual([]);
    const result = parseAgentConfig(configYaml(draft));
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) {
      expect(result.config.spec.policy.approvals.approvers).toEqual(['@omar', 'console:on-call']);
      expect(result.config.spec.console.chat).toBe(false);
    }
    const off = { ...draft, console: { enabled: false, chat: true } };
    expect(codes(validateDraft(off))).toEqual(['policy.approvers:approver-console-off']);
    const bad = { ...draft, policy: { ...draft.policy, approvers: 'console:On_Call' } };
    expect(codes(validateDraft(bad))).toEqual(['policy.approvers:approver-format']);
  });

  it('checks provider-specific model fields', () => {
    const draft = {
      ...composeDraft(),
      model: { provider: 'ollama' as const, name: 'm', fields: { baseUrl: '' } },
    };
    expect(codes(validateDraft(draft))).toEqual(['model.baseUrl:required']);
  });
});

describe('configYaml', () => {
  it('writes secret references, never values, and leaves disabled connectors out', () => {
    const draft = composeDraft();
    draft.connectors['gitlab'] = {
      enabled: false,
      access: 'read-only',
      config: { projects: 'x/y' },
      optionalSecrets: [],
    };
    const yaml = configYaml(draft);
    expect(yaml).toContain('apiKey: ${env:ANTHROPIC_API_KEY}');
    expect(yaml).toContain('token: ${env:GITHUB_TOKEN}');
    expect(yaml).toContain('kubeconfig: ${file:/secrets/kubeconfig}');
    expect(yaml).not.toContain('gitlab');
  });

  it('includes the kubeconfig by default for compose but not for kubernetes', () => {
    expect(configYaml(composeDraft())).toContain('kubeconfig:');
    expect(configYaml(kubernetesDraft())).not.toContain('kubeconfig:');
  });
});

describe('profiles and environments in the draft', () => {
  const teamDraft = () => ({
    ...kubernetesDraft('read-write-approved'),
    profile: 'team' as const,
    environments: [
      { name: 'production', production: true, namespaces: 'api', repos: '', approvers: '' },
      { name: 'staging', production: false, namespaces: 'web', repos: '', approvers: '' },
    ],
  });

  it('writes the profile and environments, and the YAML passes the real schema', () => {
    const draft = teamDraft();
    expect(validateDraft(draft)).toEqual([]);
    const yaml = configYaml(draft);
    const result = parseAgentConfig(yaml);
    expect(result.ok && result.config.spec.profile).toBe('team');
    expect(result.ok && result.config.spec.environments.map((e) => e.name)).toEqual([
      'production',
      'staging',
    ]);
    expect(yaml).not.toContain('production: false');
    expect(effectivePolicy(draft).environments[0]).toMatchObject({
      name: 'production',
      allowSelfApproval: false,
    });
  });

  it('leaves environments out of the YAML when there are none', () => {
    expect(configYaml(composeDraft())).not.toContain('environments');
    expect(configYaml(composeDraft())).toContain('profile: starter');
  });

  it('points rules nobody can satisfy at the environment that has them', () => {
    const draft = {
      ...teamDraft(),
      environments: [
        { name: 'production', production: true, namespaces: 'api', repos: '', approvers: 'U0ONE' },
      ],
    };
    const issues = validateDraft(draft);
    expect(codes(issues)).toEqual(['environment.0.approvers:policy']);
    expect(issues[0]).toMatchObject({
      step: 'environments',
      problem: { code: 'needs-other-approver', vars: { scope: 'production' } },
    });
  });

  it('checks each environment field', () => {
    const draft = {
      ...teamDraft(),
      environments: [
        { name: 'Prod', production: false, namespaces: 'API', repos: 'nope', approvers: 'omar' },
        { name: '', production: false, namespaces: '', repos: '', approvers: '' },
      ],
    };
    expect(codes(validateDraft(draft))).toEqual([
      'environment.0.name:environment-name',
      'environment.0.namespaces:namespace-format',
      'environment.0.repos:repo-format',
      'environment.0.approvers:approver-format',
      'environment.1.name:required',
      'environment.1.namespaces:policy',
    ]);
  });
});

describe('daily checks in the draft', () => {
  it('writes one schedule when on, nothing when off, and the YAML passes the real schema', () => {
    expect(configYaml(composeDraft())).not.toContain('checks:');
    const draft = composeDraft();
    draft.checks = { enabled: true, at: '08:30', days: 'weekdays', timezone: 'Asia/Amman' };
    expect(validateDraft(draft)).toEqual([]);
    // Quoted, so YAML 1.1 readers do not turn 08:30 into a number.
    expect(configYaml(draft)).toContain('at: "08:30"');
    const result = parseAgentConfig(configYaml(draft));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.spec.checks.schedules).toEqual([
      {
        name: 'daily',
        at: '08:30',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        timezone: 'Asia/Amman',
      },
    ]);
    draft.checks.days = 'every-day';
    const daily = parseAgentConfig(configYaml(draft));
    expect(daily.ok && daily.config.spec.checks.schedules[0]?.days).toHaveLength(7);
  });

  it('refuses a bad time or time zone, only while the checks are on', () => {
    const draft = composeDraft();
    draft.checks = { enabled: true, at: '9am', days: 'weekdays', timezone: 'Mars/Base' };
    expect(codes(validateDraft(draft))).toEqual([
      'checks.at:time-format',
      'checks.timezone:timezone',
    ]);
    draft.checks.enabled = false;
    expect(validateDraft(draft)).toEqual([]);
  });
});
