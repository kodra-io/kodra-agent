import { describe, expect, it } from 'vitest';
import {
  formatSecretRef,
  parseSecretRef,
  SECRET_REF_PATTERN,
  secretRefSchema,
} from './secret-ref.ts';

describe('parseSecretRef', () => {
  it.each([
    ['${env:GITHUB_TOKEN}', { scheme: 'env', name: 'GITHUB_TOKEN' }],
    ['${env:_X1}', { scheme: 'env', name: '_X1' }],
    ['${file:/secrets/kubeconfig}', { scheme: 'file', path: '/secrets/kubeconfig' }],
    ['  ${env:A}  ', { scheme: 'env', name: 'A' }],
  ])('parses %s', (input, ref) => {
    expect(parseSecretRef(input)).toEqual({ ok: true, ref });
  });

  it.each([
    ['${env:github_token}', 'capitals'],
    ['${env:1ABC}', 'capitals'],
    ['${env:}', 'capitals'],
    ['${file:relative/path}', 'absolute path'],
    ['${file:}', 'absolute path'],
    ['${vault:secret/data/x}', 'vault references are not supported yet'],
    ['${aws-sm:prod/db}', 'aws-sm references are not supported yet'],
    ['${azure-kv:kv/x}', 'azure-kv references are not supported yet'],
    ['${s3:bucket/key}', 'unknown secret reference type'],
    ['$env:A', 'not a value'],
    ['{env:A}', 'not a value'],
  ])('rejects %s', (input, expected) => {
    const result = parseSecretRef(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expected);
  });

  it('round-trips through formatSecretRef', () => {
    for (const input of ['${env:SLACK_APP_TOKEN}', '${file:/run/secrets/token}']) {
      const result = parseSecretRef(input);
      expect(result.ok && formatSecretRef(result.ref)).toBe(input);
    }
  });
});

describe('secret values never appear in errors', () => {
  const pasted = [
    'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', // gitleaks:allow (fake value for the no-echo test)
    'sk-ant-api03-SECRETSECRETSECRET', // gitleaks:allow (fake value for the no-echo test)
    'xoxb-1234-5678-SECRET', // gitleaks:allow (fake value for the no-echo test)
    '${not-a-scheme:ghp_A1b2C3d4E5f6}', // gitleaks:allow (fake value for the no-echo test)
  ];

  it.each(pasted)('parseSecretRef does not echo %s', (value) => {
    const result = parseSecretRef(value);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain('ghp_A1b2');
  });

  it.each(pasted)('secretRefSchema issues do not echo %s', (value) => {
    const result = secretRefSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(value);
  });
});

describe('SECRET_REF_PATTERN', () => {
  const pattern = new RegExp(SECRET_REF_PATTERN);

  it('agrees with the parser on env and file references', () => {
    for (const input of ['${env:A_B}', '${file:/x/y}', '${env:a}', '${vault:x}', 'plain']) {
      const parsed = parseSecretRef(input);
      expect(pattern.test(input)).toBe(parsed.ok);
    }
  });
});
