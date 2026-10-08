import { createHash, createHmac } from 'node:crypto';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';

type AwsCredentialIdentityProvider = ReturnType<typeof fromNodeProviderChain>;
type AwsCredentialIdentity = Awaited<ReturnType<AwsCredentialIdentityProvider>>;

/**
 * EKS bearer tokens, made the way `aws eks get-token` and aws-iam-authenticator make them
 * (checked against aws-iam-authenticator pkg/token/token.go, Oct 2026): a presigned STS
 * GetCallerIdentity URL with the cluster name in a signed `x-k8s-aws-id` header, valid for
 * 15 minutes after signing, encoded as `k8s-aws-v1.` + unpadded base64url.
 */
export const TOKEN_PREFIX = 'k8s-aws-v1.';
export const CLUSTER_HEADER = 'x-k8s-aws-id';
/** Presign parameter the authenticator expects (STS ignores it; tokens last 15 minutes). */
const PRESIGN_SECONDS = 60;
/** One minute of cushion before the 15-minute limit, as the authenticator does. */
const TOKEN_MINUTES = 14;

/** SHA-256 and HMAC-SHA-256 for the signer, from Node's own crypto. */
class Sha256 {
  private readonly hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash =
      secret === undefined ? createHash('sha256') : createHmac('sha256', toBuffer(secret));
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(toBuffer(data));
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
}

function toBuffer(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

export interface TokenOptions {
  clusterName: string;
  region: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  now?: Date;
}

export interface EksToken {
  token: string;
  expiresAt: Date;
}

export async function eksToken(o: TokenOptions): Promise<EksToken> {
  const now = o.now ?? new Date();
  const hostname = `sts.${o.region}.amazonaws.com`;
  const signer = new SignatureV4({
    credentials: o.credentials,
    region: o.region,
    service: 'sts',
    sha256: Sha256,
  });
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname,
      path: '/',
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
      headers: { host: hostname, [CLUSTER_HEADER]: o.clusterName },
    },
    { expiresIn: PRESIGN_SECONDS, signingDate: now },
  );
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(signed.query ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== null) query.append(key, v);
  }
  const url = `https://${hostname}/?${query.toString()}`;
  return {
    token: TOKEN_PREFIX + Buffer.from(url, 'utf8').toString('base64url'),
    expiresAt: new Date(now.getTime() + TOKEN_MINUTES * 60_000),
  };
}

/** The ExecCredential a Kubernetes client expects from an exec plugin. */
export function execCredential(token: EksToken, execInfo: string | undefined): string {
  let apiVersion = 'client.authentication.k8s.io/v1beta1';
  if (execInfo) {
    try {
      const info = JSON.parse(execInfo) as { apiVersion?: unknown };
      if (typeof info.apiVersion === 'string' && info.apiVersion) apiVersion = info.apiVersion;
    } catch {
      // Keep the default, as the authenticator does.
    }
  }
  return JSON.stringify({
    kind: 'ExecCredential',
    apiVersion,
    spec: {},
    status: {
      expirationTimestamp: token.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      token: token.token,
    },
  });
}

export interface GetTokenArgs {
  clusterName: string;
  region: string | undefined;
  roleArn: string | undefined;
  profile: string | undefined;
}

/**
 * Parses `aws [--region R] [--profile P] eks get-token --cluster-name C [--role-arn A]
 * [--region R] [--output json]`. Anything else is not supported: this is not the AWS CLI.
 */
export function parseAwsArgs(argv: readonly string[]): GetTokenArgs | { error: string } {
  const values: Record<string, string> = {};
  const words: string[] = [];
  const known = new Set([
    '--region',
    '--profile',
    '--cluster-name',
    '--cluster-id',
    '--role-arn',
    '--output',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const [name = '', inline] = arg.split(/=(.*)/s, 2);
      if (!known.has(name)) return { error: `unsupported option ${name}` };
      const value = inline ?? argv[++i];
      if (value === undefined) return { error: `${name} needs a value` };
      values[name] = value;
    } else {
      words.push(arg);
    }
  }
  if (words.join(' ') !== 'eks get-token') {
    return {
      error:
        'only `aws eks get-token` is available in the Kodra AI Agent image (for EKS kubeconfigs)',
    };
  }
  if (values['--output'] && values['--output'] !== 'json')
    return { error: 'only --output json is supported' };
  const clusterName = values['--cluster-name'] ?? values['--cluster-id'];
  if (!clusterName) return { error: '--cluster-name is required' };
  return {
    clusterName,
    region: values['--region'],
    roleArn: values['--role-arn'],
    profile: values['--profile'],
  };
}

export interface AwsShimDeps {
  env: Readonly<Record<string, string | undefined>>;
  credentials?: (args: GetTokenArgs, region: string) => AwsCredentialIdentityProvider;
  now?: () => Date;
}

/** The standard AWS credential chain, assuming --role-arn first if given. */
function defaultCredentials(args: GetTokenArgs, region: string): AwsCredentialIdentityProvider {
  const base = fromNodeProviderChain(args.profile ? { profile: args.profile } : {});
  if (!args.roleArn) return base;
  return fromTemporaryCredentials({
    masterCredentials: base,
    params: { RoleArn: args.roleArn, RoleSessionName: 'kodra-agent-eks', DurationSeconds: 900 },
    clientConfig: { region },
  });
}

/** Runs the `aws` stand-in. Returns the exit code; output and errors go to the callbacks. */
export async function awsShim(
  argv: readonly string[],
  deps: AwsShimDeps,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const args = parseAwsArgs(argv);
  if ('error' in args) {
    err(`kodra-agent: ${args.error}.`);
    return 2;
  }
  const region = args.region ?? deps.env['AWS_REGION'] ?? deps.env['AWS_DEFAULT_REGION'];
  if (!region) {
    err('kodra-agent: set --region in the kubeconfig, or AWS_REGION.');
    return 2;
  }
  try {
    const token = await eksToken({
      clusterName: args.clusterName,
      region,
      credentials: (deps.credentials ?? defaultCredentials)(args, region),
      ...(deps.now ? { now: deps.now() } : {}),
    });
    out(execCredential(token, deps.env['KUBERNETES_EXEC_INFO']));
    return 0;
  } catch (error) {
    // Only the error's message: never the credentials it may have been holding.
    err(
      `kodra-agent: could not get an EKS token: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return 1;
  }
}
