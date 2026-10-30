import type { ToolRisk } from '@kodra-agent/schema';
import READS from './read-operations.json' with { type: 'json' };

/**
 * The risk of one AWS CLI command for `call_aws` (B4). A read is a command AWS's own metadata
 * calls read-only (`read-operations.json`, generated from the pinned server); a command that
 * deletes, terminates, or removes something is destructive; anything else is a write. A
 * command that would hand back credentials or secret values, reach another endpoint, read a
 * local file, or is not one plain `aws <service> <command>` is blocked outright.
 */
export type CliRisk = { risk: ToolRisk; service: string; command: string } | { blocked: string };

const reads = READS as Readonly<Record<string, readonly string[]>>;

/** Global options that may come before the service, with whether they take a value. */
const GLOBAL_OPTIONS: Readonly<Record<string, boolean>> = {
  '--region': true,
  '--output': true,
  '--query': true,
  '--color': true,
  '--cli-read-timeout': true,
  '--cli-connect-timeout': true,
  '--cli-binary-format': true,
  '--no-paginate': false,
  '--no-cli-pager': false,
};

/** Options that change who signs the call, where it goes, or what it trusts, anywhere. */
const REFUSED_OPTIONS = [
  '--profile',
  '--endpoint-url',
  '--no-verify-ssl',
  '--ca-bundle',
  '--no-sign-request',
  '--debug',
];

/** Commands whose answer is a credential or a secret value, which never goes to the model. */
const SECRETS: Readonly<Record<string, readonly string[]>> = {
  secretsmanager: ['get-secret-value', 'batch-get-secret-value'],
  kms: [
    'decrypt',
    'generate-data-key',
    'generate-data-key-pair',
    'generate-mac',
    're-encrypt',
    'derive-shared-secret',
  ],
  sts: [
    'assume-role',
    'assume-role-with-saml',
    'assume-role-with-web-identity',
    'assume-root',
    'get-session-token',
    'get-federation-token',
  ],
  iam: [
    'create-access-key',
    'create-service-specific-credential',
    'reset-service-specific-credential',
  ],
  ecr: ['get-login-password', 'get-authorization-token'],
  'ecr-public': ['get-login-password', 'get-authorization-token'],
  codeartifact: ['get-authorization-token'],
  'cognito-identity': [
    'get-credentials-for-identity',
    'get-open-id-token',
    'get-open-id-token-for-developer-identity',
  ],
  sso: ['get-role-credentials'],
  'sso-oidc': ['create-token', 'create-token-with-iam'],
  rds: ['generate-db-auth-token'],
  dsql: ['generate-db-connect-auth-token', 'generate-db-connect-admin-auth-token'],
  redshift: ['get-cluster-credentials', 'get-cluster-credentials-with-iam'],
  'redshift-serverless': ['get-credentials'],
  eks: ['get-token'],
  ec2: ['get-password-data'],
  lightsail: [
    'get-instance-access-details',
    'get-relational-database-master-user-password',
    'download-default-key-pair',
  ],
  s3: ['presign'],
};

/** Parameter Store reads return plaintext SecureString values only with this flag. */
const DECRYPTING = [
  'get-parameter',
  'get-parameters',
  'get-parameters-by-path',
  'get-parameter-history',
];

/** The `aws s3` commands, which are not API operations and so are not in the metadata. */
const S3: Readonly<Record<string, ToolRisk>> = {
  ls: 'read',
  cp: 'write',
  sync: 'write',
  mb: 'write',
  website: 'write',
  mv: 'destructive',
  rm: 'destructive',
  rb: 'destructive',
};

/** CLI commands that work on this machine, not on AWS. */
const LOCAL = ['configure', 'login', 'logout', 'sso', 'history', 'help'];

/** A command that removes something: the first word, or the word after `batch`. */
const REMOVING =
  /^(batch-)?(delete|terminate|remove|deregister|purge|revoke|destroy|release|abort)(-|$)/;

/** Splits like a shell would, without running one: quotes group, nothing else is special. */
function words(command: string): string[] | null {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = '';
      inWord = false;
    } else if (/[|;&<>`$\\]/.test(ch)) {
      return null;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(word);
  return out;
}

export function awsCliRisk(command: unknown): CliRisk {
  if (typeof command !== 'string' || command.length > 20_000) {
    return { blocked: 'call_aws needs one AWS CLI command as text' };
  }
  const parts = words(command.trim());
  if (!parts || parts[0] !== 'aws') {
    return {
      blocked:
        'only one plain `aws <service> <command>` runs: no pipes, redirects, variables, or other programs',
    };
  }
  let i = 1;
  while (parts[i]?.startsWith('--')) {
    const option = (parts[i] ?? '').split('=')[0] ?? '';
    const takesValue = GLOBAL_OPTIONS[option];
    if (takesValue === undefined) {
      return {
        blocked: `${option} is not allowed before the service; put command options after it`,
      };
    }
    i += takesValue && !(parts[i] ?? '').includes('=') ? 2 : 1;
  }
  const service = parts[i] ?? '';
  const sub = parts[i + 1] ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(service) || !/^[a-z0-9][a-z0-9-]*$/.test(sub)) {
    return { blocked: 'name the service and the command, like `aws ec2 describe-instances`' };
  }
  for (const part of parts) {
    const option = part.split('=')[0] ?? '';
    if (REFUSED_OPTIONS.includes(option)) {
      return {
        blocked: `${option} is not allowed: calls use the connector's own credentials and endpoint`,
      };
    }
    if (/(^|=)fileb?:\/\//.test(part)) {
      return { blocked: 'local files are not readable: pass values inline' };
    }
  }
  if (LOCAL.includes(service)) {
    return { blocked: `aws ${service} works on this machine, not on AWS` };
  }
  if (
    SECRETS[service]?.includes(sub) ||
    (service === 'ssm' &&
      DECRYPTING.includes(sub) &&
      parts.some((p) => p.startsWith('--with-decryption')))
  ) {
    return {
      blocked: `aws ${service} ${sub} returns credentials or secret values, which never go to the model`,
    };
  }
  const named = { service, command: sub };
  if (service === 's3') {
    const risk = S3[sub];
    return risk ? { risk, ...named } : { risk: 'write', ...named };
  }
  if (sub === 'wait' || reads[service]?.includes(sub)) return { risk: 'read', ...named };
  if (REMOVING.test(sub)) return { risk: 'destructive', ...named };
  return { risk: 'write', ...named };
}
