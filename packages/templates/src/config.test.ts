import { parseAgentConfig } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { configYaml, validateDraft } from './config.ts';
import { emptyDraft } from './draft.ts';
import { composeDraft, kubernetesDraft, withConnector } from './test-drafts.ts';

const codes = (issues: ReturnType<typeof validateDraft>) =>
  issues.map((i) => `${i.field}:${i.code}`);

describe('validateDraft', () => {
  it('lists what an empty draft is missing', () => {
    expect(codes(validateDraft(emptyDraft()))).toEqual([
      'name:required',
      'model.name:required',
      'policy.approvers:required',
    ]);
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
    expect(issue?.code === 'pattern' && issue.hint?.en).toBe(
      'use owner/repo, like acme/payments-api',
    );
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
