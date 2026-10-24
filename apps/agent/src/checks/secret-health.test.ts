import { describe, expect, it } from 'vitest';
import { secretFindings } from './rules.ts';
import { secretExpiry } from './secret-health.ts';

const jwt = (exp: number) =>
  [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(JSON.stringify({ exp })).toString('base64url'),
    'sig',
  ].join('.');
const at = (iso: string) => Date.parse(iso) / 1000;

describe('secret hygiene (M29b)', () => {
  it("finds a JWT's expiry, and the earliest one in a kubeconfig", () => {
    expect(secretExpiry(jwt(at('2026-11-01T00:00:00Z')))?.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    const kubeconfig = `apiVersion: v1
kind: Config
users:
  - name: a
    user:
      token: ${jwt(at('2026-12-01T00:00:00Z'))}
  - name: b
    user:
      token: ${jwt(at('2026-11-05T00:00:00Z'))}
`;
    expect(secretExpiry(kubeconfig)?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(secretExpiry('glpat-not-a-jwt')).toBeNull();
  });

  it('reports expired, expiring, and old secrets by label only', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const findings = secretFindings(
      [
        {
          id: 'kubernetes.kubeconfig',
          label: 'Kubernetes kubeconfig (file /secrets/kubeconfig)',
          expiresAt: new Date('2026-10-20T00:00:00Z'),
          setAt: null,
        },
        {
          id: 'gitlab.token',
          label: 'GitLab token (GITLAB_TOKEN)',
          expiresAt: new Date('2026-11-01T00:00:00Z'),
          setAt: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'slack.botToken',
          label: 'Slack bot token (SLACK_BOT_TOKEN)',
          expiresAt: null,
          setAt: new Date('2026-10-01T00:00:00Z'),
        },
      ],
      now,
    );
    expect(findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', 'Kubernetes kubeconfig (file /secrets/kubeconfig) expired on 2026-10-20'],
      ['warning', 'GitLab token (GITLAB_TOKEN) expires on 2026-11-01'],
      ['warning', 'GitLab token (GITLAB_TOKEN) was set 145 days ago; rotate it (every 90 days)'],
    ]);
  });
});
