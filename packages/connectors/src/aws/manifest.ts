import { defineManifest, type SetupStep } from '@kodra-agent/schema';
import { PATTERNS } from '../shared.ts';

const chainNote =
  'Leave both AWS keys empty to use the standard AWS credentials, such as an IAM role for the service account.';

/** AWS ReadOnlyAccess can read some secret values; this takes them away again. */
const DENY_SECRETS =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["secretsmanager:GetSecretValue","secretsmanager:BatchGetSecretValue","kms:Decrypt","ssm:GetParameter","ssm:GetParameters","ssm:GetParametersByPath","ssm:GetParameterHistory"],"Resource":"*"}]}';

const READ_ONLY_ARN = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

const UNIX_KEY = `echo '${DENY_SECRETS}' > kodra-agent-deny-secrets.json
aws iam create-user --user-name kodra-agent
aws iam attach-user-policy --user-name kodra-agent --policy-arn ${READ_ONLY_ARN}
aws iam put-user-policy --user-name kodra-agent --policy-name kodra-agent-deny-secrets --policy-document file://kodra-agent-deny-secrets.json
aws iam create-access-key --user-name kodra-agent`;

/** An IAM user that reads everything except secret values, and its key (M28). */
const keySteps: SetupStep[] = [
  {
    text: 'Leave both keys empty to use the standard AWS credentials instead, such as an IAM role for the service account.',
  },
  {
    text: 'Or create an IAM user with AWS ReadOnlyAccess, minus secret values, and its access key. Copy AccessKeyId and SecretAccessKey from the output; AWS shows the secret only once. For read-write access, attach the policies for what the agent may change instead.',
    run: {
      linux: UNIX_KEY,
      macos: UNIX_KEY,
      windows: `Set-Content -Path kodra-agent-deny-secrets.json -Value '${DENY_SECRETS}'
aws iam create-user --user-name kodra-agent
aws iam attach-user-policy --user-name kodra-agent --policy-arn ${READ_ONLY_ARN}
aws iam put-user-policy --user-name kodra-agent --policy-name kodra-agent-deny-secrets --policy-document file://kodra-agent-deny-secrets.json
aws iam create-access-key --user-name kodra-agent`,
    },
  },
];

const scopes = {
  'read-only': [
    'AWS managed policy ReadOnlyAccess',
    'Deny secretsmanager:GetSecretValue, kms:Decrypt, and ssm:GetParameter*',
  ],
  'read-write-approved': [
    'ReadOnlyAccess, as for read-only',
    'Write actions only for the services and resources the agent may change',
  ],
};

export default defineManifest({
  id: 'aws',
  displayName: 'AWS',
  category: 'cloud',
  status: 'available',
  description:
    'Read any AWS service with the AWS CLI: EKS, EC2, CloudWatch metrics, logs, and alarms, and more. Changes need approval.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'region',
      required: true,
      description: 'AWS region.',
      pattern: PATTERNS.awsRegion,
      patternHint: 'use an AWS region, like eu-central-1',
      example: 'eu-central-1',
    },
  ],
  secrets: [
    {
      key: 'accessKeyId',
      envVar: 'AWS_ACCESS_KEY_ID',
      defaultRef: 'env',
      required: false,
      defaultFor: ['compose'],
      description: 'AWS access key id.',
      howToCreate: chainNote,
      minimumScopes: scopes,
      probe: 'aws.get-caller-identity',
      steps: keySteps,
    },
    {
      key: 'secretAccessKey',
      envVar: 'AWS_SECRET_ACCESS_KEY',
      defaultRef: 'env',
      required: false,
      defaultFor: ['compose'],
      description: 'AWS secret access key.',
      howToCreate: chainNote,
      minimumScopes: scopes,
      probe: 'aws.get-caller-identity',
      steps: keySteps,
    },
  ],
  healthProbe: 'aws.get-caller-identity',
  tools: {
    // awslabs.aws-api-mcp-server 1.5.6. Each call's risk comes from its command (riskFrom).
    call_aws: 'write',
  },
  riskFrom: { call_aws: { kind: 'aws-cli', commandArg: 'cli_command' } },
  // Sends the question to an AWS endpoint; the model writes CLI commands without it.
  hiddenTools: ['suggest_aws_commands'],
  // 0.3.x picked the EKS and CloudWatch servers; one server covers every service now.
  retired: { config: ['services'] },
  runtime: {
    type: 'mcp-stdio',
    name: 'aws-api',
    source: {
      kind: 'pypi',
      package: 'awslabs.aws-api-mcp-server',
      version: '1.5.6',
      command: 'awslabs.aws-api-mcp-server',
    },
    args: [],
    env: {
      AWS_REGION: { setting: 'region' },
      AWS_ACCESS_KEY_ID: { secret: 'accessKeyId' },
      AWS_SECRET_ACCESS_KEY: { secret: 'secretAccessKey' },
      AWS_API_MCP_TELEMETRY: { value: 'false' },
      AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS: { value: 'no-access' },
      AWS_API_MCP_SUPPRESS_DEPRECATION_WARNING: { value: 'true' },
      FASTMCP_LOG_LEVEL: { value: 'ERROR' },
    },
    // The server's own check too: it refuses anything AWS does not list as a read.
    accessEnv: { 'read-only': { READ_OPERATIONS_ONLY: 'true' } },
    // IAM roles for service accounts (IRSA), container credentials, and profiles.
    inheritEnv: [
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_PROFILE',
      'AWS_STS_REGIONAL_ENDPOINTS',
    ],
  },
  permissionsSummary: {
    'read-only': [
      'Runs AWS CLI commands that AWS lists as reads. Changes nothing.',
      'Commands that return secret values or credentials are blocked.',
      'CloudWatch Logs Insights queries are billed by AWS for the data they scan.',
    ],
    'read-write-approved': [
      'Reads run; every command that changes something waits for approval.',
      'Commands that delete, terminate, or remove are blocked unless policy allows them with approval.',
      'Commands that return secret values or credentials are blocked.',
    ],
  },
});
