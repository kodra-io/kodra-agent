import { describe, expect, it } from 'vitest';
import { buildAgentConfigSchema, DEFAULT_AUDIT_PATH } from './agent-config.ts';
import { formatIssue, parseAgentConfig, type ParseResult } from './parse.ts';
import { fixtureList } from './test-fixtures.ts';

const schema = buildAgentConfigSchema(fixtureList);
const parse = (text: string) => parseAgentConfig(text, schema);

const valid = `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: demo-agent
spec:
  target: compose
  model:
    provider: ollama
    name: some-model
    baseUrl: http://ollama:11434
  connectors:
    src:
      enabled: true
      access: read-write-approved
      config:
        repos: [acme/api]
      secrets:
        token: \${env:SRC_TOKEN}
  policy:
    approvals:
      approvers: ['@omar']
`;

function issues(result: ParseResult) {
  if (result.ok) throw new Error('expected the config to be invalid');
  return result.issues;
}

function messages(result: ParseResult) {
  return issues(result).map((i) => formatIssue(i));
}

describe('parseAgentConfig', () => {
  it('accepts a valid config and applies defaults', () => {
    const result = parse(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.spec.policy).toEqual({
      approvals: { required: true, approvers: ['@omar'], expiresAfterMinutes: 15 },
      destructiveActions: 'deny',
    });
    expect(result.config.spec.audit.path).toBe(DEFAULT_AUDIT_PATH);
    expect(result.config.spec.telemetry.enabled).toBe(false);
  });

  it('applies connector defaults', () => {
    const text = valid.replace(
      '  policy:',
      '    mon:\n      enabled: true\n      config:\n        url: http://prom:9090\n  policy:',
    );
    const result = parse(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.spec.connectors['mon']).toEqual({
        enabled: true,
        access: 'read-only',
        config: { url: 'http://prom:9090', interval: 60 },
      });
    }
  });

  it('points at the line and column of the bad value', () => {
    const result = parse(valid.replace('target: compose', 'target: swarm'));
    expect(issues(result)).toEqual([
      { path: 'spec.target', message: 'must be compose or kubernetes', line: 6, column: 3 },
    ]);
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:6:3 spec.target: must be compose or kubernetes',
    ]);
  });

  it('points at an unknown key itself', () => {
    const result = parse(valid.replace('      access:', '      acess:'));
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:14:7 spec.connectors.src: unknown key acess. Allowed: enabled, access, config, secrets.',
    ]);
  });

  it('names the unknown connector and lists the available ones', () => {
    const result = parse(valid.replace('    src:', '    nope:\n      enabled: true\n    src:'));
    expect(messages(result)[0]).toBe(
      'kodra-agent.yaml:12:5 spec.connectors: unknown connector nope. Available: src, ci, pinned-ci, mon, chat.',
    );
  });

  it('says "is required" for a missing field, pointing at its parent', () => {
    const result = parse(valid.replace('      secrets:\n        token: ${env:SRC_TOKEN}\n', ''));
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:12:5 spec.connectors.src.secrets: is required',
    ]);
  });

  it('uses the manifest pattern hint for a bad config value', () => {
    const result = parse(valid.replace('[acme/api]', '[acme]'));
    expect(messages(result)).toEqual([
      'kodra-agent.yaml:16:17 spec.connectors.src.config.repos.0: use owner/repo',
    ]);
  });

  it('reports YAML syntax errors with a position', () => {
    const result = parse('apiVersion: [kodra.io\nkind: Agent\n');
    const [issue] = issues(result);
    expect(issue?.message).toMatch(/^YAML syntax error: /);
    expect(issue?.line).toBeGreaterThan(0);
  });

  it('rejects duplicate keys', () => {
    const result = parse(valid.replace('kind: Agent', 'kind: Agent\nkind: Agent'));
    expect(issues(result)[0]?.message).toMatch(/YAML syntax error: .*unique/i);
  });

  it('rejects a document that is not a mapping', () => {
    expect(messages(parse('- a\n- b\n'))).toEqual(['kodra-agent.yaml:1:1 must be a YAML mapping']);
  });

  describe('apiVersion', () => {
    it('reports an unsupported version alone, with the reason', () => {
      const result = parse(
        valid.replace('kodra.io/v1alpha1', 'kodra.io/v2').replace('compose', 'swarm'),
      );
      expect(messages(result)).toEqual([
        'kodra-agent.yaml:1:1 apiVersion: kodra.io/v2 is not supported by this agent, which reads kodra.io/v1alpha1. Upgrade kodra-agent or regenerate the config.',
      ]);
    });

    it('rejects a different API group', () => {
      const result = parse(valid.replace('kodra.io/v1alpha1', 'apps/v1'));
      expect(issues(result)[0]?.message).toBe(
        'apps/v1 is not a Kodra AI Agent config. Expected kodra.io/v1alpha1.',
      );
    });

    it('reports a missing apiVersion', () => {
      const result = parse(valid.replace('apiVersion: kodra.io/v1alpha1\n', ''));
      expect(issues(result)[0]).toMatchObject({
        path: 'apiVersion',
        message: 'is required. Set it to kodra.io/v1alpha1.',
      });
    });
  });

  it('never repeats a pasted secret value', () => {
    const secret = 'ghp_SuperSecretValue1234567890'; // gitleaks:allow (fake value)
    const result = parse(valid.replace('${env:SRC_TOKEN}', secret));
    const all = JSON.stringify(issues(result)) + messages(result).join('\n');
    expect(all).toContain('must be a secret reference');
    expect(all).not.toContain(secret);
  });
});
