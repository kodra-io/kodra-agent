import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from './redactor.ts';

describe('Redactor', () => {
  it('masks a registered value wherever it appears', () => {
    const r = new Redactor();
    r.add('s3cr3t-value-123');
    expect(r.redact('token=s3cr3t-value-123; again s3cr3t-value-123')).toBe(
      `token=${REDACTED}; again ${REDACTED}`,
    );
  });

  it('masks the JSON-escaped, URL-encoded, and base64 forms', () => {
    const value = 'p@ss "word"/with+chars=';
    const r = new Redactor();
    r.add(value);
    const forms = [
      JSON.stringify({ v: value }),
      `https://x.test/?k=${encodeURIComponent(value)}`,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
    ];
    for (const form of forms) {
      expect(r.redact(form), form).not.toContain(value);
      expect(r.redact(form)).toContain(REDACTED);
    }
    expect(r.redact(forms[0] ?? '')).not.toContain('p@ss \\"word\\"');
  });

  it('masks a longer value whole when it contains a shorter registered one', () => {
    const r = new Redactor();
    r.add('abcd1234');
    r.add('abcd1234-extended-part');
    expect(r.redact('x abcd1234-extended-part y')).toBe(`x ${REDACTED} y`);
  });

  it('ignores very short values so normal text survives', () => {
    const r = new Redactor();
    r.add('ab');
    r.add('   ');
    expect(r.size).toBe(0);
    expect(r.redact('about absent')).toBe('about absent');
  });

  it('masks the trimmed form of a value with stray whitespace', () => {
    const r = new Redactor();
    r.add('  padded-secret-value\n');
    expect(r.redact('got padded-secret-value')).toBe(`got ${REDACTED}`);
  });

  it.each([
    ['GitHub classic', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'], // gitleaks:allow (fake)
    ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'], // gitleaks:allow (fake)
    ['GitLab', 'glpat-abcdefghijklmnopqrstu'], // gitleaks:allow (fake)
    ['Slack bot', 'xoxb-1234567890-0987654321-abcdefghijkl'], // gitleaks:allow (fake)
    ['Slack app', 'xapp-1-A0123456789-0123456789-abcdef'], // gitleaks:allow (fake)
    ['Anthropic', 'sk-ant-api03-abcdefghijklmnop'], // gitleaks:allow (fake)
    ['OpenAI', 'sk-proj-abcdefghijklmnopqrstuvwxyz'], // gitleaks:allow (fake)
    ['AWS key id', 'AKIAABCDEFGHIJKLMNOP'], // gitleaks:allow (fake)
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'], // gitleaks:allow (fake)
  ])('masks an unregistered %s token', (_name, token) => {
    const r = new Redactor();
    expect(r.redact(`value: ${token} end`)).toBe(`value: ${REDACTED} end`);
  });

  it('keeps the Bearer prefix and masks the token', () => {
    const r = new Redactor();
    expect(r.redact('Authorization: Bearer abc.def-ghi_jkl')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('masks private keys and kubeconfig credentials', () => {
    const r = new Redactor();
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----'; // gitleaks:allow (fake)
    expect(r.redact(`before ${pem} after`)).toBe(`before ${REDACTED} after`);
    expect(r.redact('    client-key-data: LS0tLS1CRUdJTiBSU0E=')).toBe(
      `    client-key-data: ${REDACTED}`,
    );
    expect(r.redact('  token: abcdefgh12345678')).toBe(`  token: ${REDACTED}`); // gitleaks:allow (fake)
  });

  it('masks credentials inside a structured secret even when they appear alone', () => {
    const r = new Redactor();
    r.add(
      'apiVersion: v1\nusers:\n- name: u\n  user:\n    token: lone-token-value-123\n    client-key-data: "QUJDREVGR0hJSktM"\n', // gitleaks:allow (fake)
    );
    expect(r.redact('found lone-token-value-123 and QUJDREVGR0hJSktM')).toBe(
      `found ${REDACTED} and ${REDACTED}`,
    );
    // Ordinary fields are not treated as secrets.
    expect(r.redact('apiVersion: v1, name: u')).toBe('apiVersion: v1, name: u');
  });

  it('redactValue serializes objects first', () => {
    const r = new Redactor();
    r.add('hidden-value-xyz');
    expect(r.redactValue({ nested: { key: 'hidden-value-xyz' } })).toBe(
      `{"nested":{"key":"${REDACTED}"}}`,
    );
  });
});
