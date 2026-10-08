import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awsShim, eksToken, execCredential, parseAwsArgs, TOKEN_PREFIX } from './eks-token.ts';

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', // gitleaks:allow (AWS docs example)
};
const NOW = new Date('2026-10-08T09:30:00Z');

const decode = (token: string) =>
  new URL(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8'));

/** RFC 3986 encoding, as SigV4 canonical queries use. */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

/** The SigV4 query signature, computed from the AWS spec, independently of the signer. */
function expectedSignature(url: URL, cluster: string, secret: string): string {
  const params = [...url.searchParams].filter(([k]) => k !== 'X-Amz-Signature');
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    'GET',
    '/',
    query,
    `host:${url.host}`,
    `x-k8s-aws-id:${cluster}`,
    '',
    'host;x-k8s-aws-id',
    sha256(''),
  ].join('\n');
  const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
  const scope = (url.searchParams.get('X-Amz-Credential') ?? '').split('/').slice(1).join('/');
  const [day = '', region = '', service = ''] = scope.split('/');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
  return createHmac('sha256', key).update(toSign).digest('hex');
}

describe('eksToken', () => {
  it('is a presigned STS GetCallerIdentity URL, as aws-iam-authenticator accepts it', async () => {
    const { token, expiresAt } = await eksToken({
      clusterName: 'kodra-cluster',
      region: 'us-east-1',
      credentials: CREDS,
      now: NOW,
    });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token).not.toContain('='); // unpadded base64url
    const url = decode(token);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('sts.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/');
    // Only the parameters the authenticator allows.
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        'Action',
        'Version',
        'X-Amz-Algorithm',
        'X-Amz-Credential',
        'X-Amz-Date',
        'X-Amz-Expires',
        'X-Amz-Signature',
        'X-Amz-SignedHeaders',
      ].sort(),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      Action: 'GetCallerIdentity',
      Version: '2011-06-15',
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': 'AKIDEXAMPLE/20261008/us-east-1/sts/aws4_request',
      'X-Amz-Date': '20261008T093000Z',
      'X-Amz-Expires': '60',
      'X-Amz-SignedHeaders': 'host;x-k8s-aws-id',
    });
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      expectedSignature(url, 'kodra-cluster', CREDS.secretAccessKey),
    );
    expect(expiresAt.toISOString()).toBe('2026-10-08T09:44:00.000Z');
  });

  it('carries a session token, and a different cluster changes the signature', async () => {
    const a = decode(
      (
        await eksToken({
          clusterName: 'a',
          region: 'eu-central-1',
          credentials: { ...CREDS, sessionToken: 'session-xyz' },
          now: NOW,
        })
      ).token,
    );
    const b = decode(
      (
        await eksToken({
          clusterName: 'b',
          region: 'eu-central-1',
          credentials: { ...CREDS, sessionToken: 'session-xyz' },
          now: NOW,
        })
      ).token,
    );
    expect(a.host).toBe('sts.eu-central-1.amazonaws.com');
    expect(a.searchParams.get('X-Amz-Security-Token')).toBe('session-xyz');
    expect(a.searchParams.get('X-Amz-Signature')).toBe(
      expectedSignature(a, 'a', CREDS.secretAccessKey),
    );
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'));
  });
});

describe('execCredential', () => {
  const token = { token: 'k8s-aws-v1.abc', expiresAt: new Date('2026-10-08T09:44:00.123Z') };

  it('answers with the API version the client asked for', () => {
    const info = JSON.stringify({
      apiVersion: 'client.authentication.k8s.io/v1',
      kind: 'ExecCredential',
    });
    expect(JSON.parse(execCredential(token, info))).toEqual({
      kind: 'ExecCredential',
      apiVersion: 'client.authentication.k8s.io/v1',
      spec: {},
      status: { expirationTimestamp: '2026-10-08T09:44:00Z', token: 'k8s-aws-v1.abc' },
    });
  });

  it('defaults to v1beta1', () => {
    expect(JSON.parse(execCredential(token, undefined))).toMatchObject({
      apiVersion: 'client.authentication.k8s.io/v1beta1',
    });
    expect(JSON.parse(execCredential(token, 'not json'))).toMatchObject({
      apiVersion: 'client.authentication.k8s.io/v1beta1',
    });
  });
});

describe('parseAwsArgs', () => {
  it('reads what `aws eks update-kubeconfig` writes', () => {
    expect(
      parseAwsArgs([
        '--region',
        'us-east-1',
        'eks',
        'get-token',
        '--cluster-name',
        'kodra-cluster',
        '--output',
        'json',
      ]),
    ).toEqual({
      clusterName: 'kodra-cluster',
      region: 'us-east-1',
      roleArn: undefined,
      profile: undefined,
    });
    expect(
      parseAwsArgs([
        'eks',
        'get-token',
        '--cluster-name=c',
        '--role-arn',
        'arn:aws:iam::1:role/r',
        '--profile',
        'dev',
      ]),
    ).toEqual({
      clusterName: 'c',
      region: undefined,
      roleArn: 'arn:aws:iam::1:role/r',
      profile: 'dev',
    });
  });

  it('refuses anything that is not eks get-token', () => {
    expect(parseAwsArgs(['s3', 'ls'])).toEqual({
      error:
        'only `aws eks get-token` is available in the Kodra AI Agent image (for EKS kubeconfigs)',
    });
    expect(parseAwsArgs(['eks', 'get-token'])).toEqual({ error: '--cluster-name is required' });
    expect(parseAwsArgs(['eks', 'get-token', '--cluster-name', 'c', '--debug'])).toEqual({
      error: 'unsupported option --debug',
    });
    expect(parseAwsArgs(['eks', 'get-token', '--cluster-name', 'c', '--output', 'text'])).toEqual({
      error: 'only --output json is supported',
    });
  });
});

describe('awsShim', () => {
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const seen: { roleArn?: string | undefined; region?: string }[] = [];
    const code = await awsShim(
      argv,
      {
        env,
        now: () => NOW,
        credentials: (args, region) => {
          seen.push({ roleArn: args.roleArn, region });
          return () => Promise.resolve(CREDS);
        },
      },
      (t) => out.push(t),
      (t) => err.push(t),
    );
    return { code, out, err, seen };
  };

  it('prints an ExecCredential, assuming the role when the kubeconfig names one', async () => {
    const r = await run(
      [
        'eks',
        'get-token',
        '--cluster-name',
        'kodra-cluster',
        '--role-arn',
        'arn:aws:iam::1:role/r',
      ],
      {
        AWS_REGION: 'us-east-1',
      },
    );
    expect(r.code).toBe(0);
    expect(r.seen).toEqual([{ roleArn: 'arn:aws:iam::1:role/r', region: 'us-east-1' }]);
    const cred = JSON.parse(r.out[0] ?? '') as { status: { token: string } };
    expect(cred.status.token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it('needs a region, and never prints credentials in an error', async () => {
    expect((await run(['eks', 'get-token', '--cluster-name', 'c'])).err).toEqual([
      'kodra-agent: set --region in the kubeconfig, or AWS_REGION.',
    ]);
    const failing = await awsShim(
      ['eks', 'get-token', '--cluster-name', 'c', '--region', 'us-east-1'],
      { env: {}, credentials: () => () => Promise.reject(new Error('no credentials found')) },
      () => undefined,
      (t) => {
        expect(t).toBe('kodra-agent: could not get an EKS token: no credentials found');
      },
    );
    expect(failing).toBe(1);
  });
});
