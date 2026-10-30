import { describe, expect, it } from 'vitest';
import { decide } from '../policy.ts';
import { awsCliRisk } from './cli-risk.ts';
import READS from './read-operations.json' with { type: 'json' };

const risk = (command: unknown) => {
  const result = awsCliRisk(command);
  return 'blocked' in result ? 'blocked' : result.risk;
};

describe('awsCliRisk', () => {
  it.each([
    'aws ec2 describe-instances',
    'aws eks list-clusters',
    'aws eks describe-cluster --name shop',
    'aws logs filter-log-events --log-group-name /aws/eks/shop --filter-pattern "ERROR"',
    'aws cloudwatch describe-alarms --state-value ALARM',
    'aws --region us-east-1 --output json sts get-caller-identity',
    'aws --region=us-east-1 ec2 describe-vpcs',
    'aws s3 ls s3://bucket',
    'aws ec2 wait instance-running --instance-ids i-1',
    'aws ssm get-parameter --name /app/flag',
    'aws ecr describe-images --repository-name shop',
  ])('reads: %s', (command) => {
    expect(risk(command)).toBe('read');
  });

  it.each([
    'aws ec2 run-instances --image-id ami-1',
    'aws eks update-nodegroup-config --cluster-name shop --nodegroup-name a',
    'aws ecs update-service --cluster c --service s --desired-count 2',
    'aws s3 cp a.txt s3://bucket/a.txt',
    'aws s3 sync s3://a s3://b',
    'aws secretsmanager put-secret-value --secret-id s --secret-string x',
    'aws ec2 stop-instances --instance-ids i-1',
  ])('writes: %s', (command) => {
    expect(risk(command)).toBe('write');
  });

  it.each([
    'aws ec2 terminate-instances --instance-ids i-1',
    'aws eks delete-cluster --name shop',
    'aws s3 rm s3://bucket/a --recursive',
    'aws s3 rb s3://bucket',
    'aws s3 mv s3://a/x s3://b/x',
    'aws iam remove-role-from-instance-profile --role-name r --instance-profile-name p',
    'aws dynamodb batch-delete-table --table-name t',
    'aws ec2 deregister-image --image-id ami-1',
    'aws sqs purge-queue --queue-url q',
  ])('destructive: %s', (command) => {
    expect(risk(command)).toBe('destructive');
  });

  it.each([
    'aws secretsmanager get-secret-value --secret-id prod/db',
    'aws secretsmanager batch-get-secret-value --secret-id-list a',
    'aws kms decrypt --ciphertext-blob abc',
    'aws sts assume-role --role-arn arn:aws:iam::1:role/r --role-session-name s',
    'aws sts get-session-token',
    'aws iam create-access-key --user-name u',
    'aws ecr get-login-password',
    'aws eks get-token --cluster-name shop',
    'aws rds generate-db-auth-token --hostname h --port 3306 --username u',
    'aws ssm get-parameter --name /db/password --with-decryption',
    'aws ssm get-parameters-by-path --path / --with-decryption=true',
    'aws ec2 get-password-data --instance-id i-1',
    'aws s3 presign s3://bucket/key',
  ])('blocks secrets: %s', (command) => {
    expect(awsCliRisk(command)).toEqual({
      blocked: expect.stringMatching(/credentials or secret values/) as unknown,
    });
  });

  it.each([
    ['aws ec2 describe-instances | grep i-', /no pipes/],
    ['aws ec2 describe-instances; rm -rf /', /no pipes/],
    ['aws ec2 describe-instances && curl x', /no pipes/],
    ['aws ec2 describe-instances > out.json', /no pipes/],
    ['aws ec2 describe-instances --filters $(cat f)', /no pipes/],
    ['aws ec2 describe-instances --filters `id`', /no pipes/],
    ['aws ec2 describe-instances "unclosed', /no pipes/],
    ['kubectl get pods', /no pipes/],
    ['python -c 1', /no pipes/],
    ['aws --profile admin ec2 describe-instances', /--profile is not allowed before/],
    ['aws ec2 describe-instances --profile admin', /--profile is not allowed:/],
    ['aws ec2 describe-instances --endpoint-url https://evil.example', /--endpoint-url/],
    ['aws s3 ls --no-sign-request', /--no-sign-request/],
    ['aws ec2 describe-instances --debug', /--debug/],
    ['aws ec2 run-instances --cli-input-json file://x.json', /local files/],
    ['aws s3api put-object --body fileb:///etc/passwd --bucket b --key k', /local files/],
    ['aws configure list', /works on this machine/],
    ['aws sso login', /works on this machine/],
    ['aws ec2', /name the service and the command/],
    ['aws EC2 Describe-Instances', /name the service and the command/],
  ])('blocks %s', (command, reason) => {
    const result = awsCliRisk(command);
    expect('blocked' in result && result.blocked).toMatch(reason);
  });

  it('blocks anything that is not a command string', () => {
    expect(risk(undefined)).toBe('blocked');
    expect(risk(['aws', 'ec2'])).toBe('blocked');
    expect(risk(`aws ec2 describe-instances ${'x'.repeat(20_001)}`)).toBe('blocked');
  });

  it('keeps quoted shell characters as data', () => {
    expect(risk(`aws logs filter-log-events --log-group-name g --filter-pattern "a | b; c"`)).toBe(
      'read',
    );
  });

  it('lists no secret-returning command as a read', () => {
    const reads = READS as Record<string, string[]>;
    expect(reads['secretsmanager']).not.toContain('put-secret-value');
    for (const command of [
      'aws ec2 describe-instances',
      'aws secretsmanager list-secrets',
      'aws secretsmanager describe-secret --secret-id s',
    ]) {
      expect(risk(command)).toBe('read');
    }
  });
});

describe('call_aws in the policy engine', () => {
  const call = (
    command: string,
    access: 'read-only' | 'read-write-approved',
    destructiveActions: 'deny' | 'require-approval' = 'deny',
  ) => {
    const d = decide({
      risk: 'write',
      riskFrom: { kind: 'aws-cli', commandArg: 'cli_command' },
      access,
      destructiveActions,
      guards: [],
      args: { cli_command: command },
      settings: {},
    });
    return d.kind === 'block' ? `block: ${d.reason}` : d.kind;
  };

  it('runs reads at either access level', () => {
    expect(call('aws ec2 describe-instances', 'read-only')).toBe('allow');
    expect(call('aws ec2 describe-instances', 'read-write-approved')).toBe('allow');
  });

  it('asks for approval for a write, and only with read-write access', () => {
    expect(call('aws ecs update-service --service s', 'read-write-approved')).toBe('approve');
    expect(call('aws ecs update-service --service s', 'read-only')).toBe(
      'block: this connector is read-only',
    );
  });

  it('blocks deletes unless policy allows them with approval', () => {
    expect(call('aws eks delete-cluster --name shop', 'read-write-approved')).toBe(
      'block: destructive actions are denied by policy',
    );
    expect(
      call('aws eks delete-cluster --name shop', 'read-write-approved', 'require-approval'),
    ).toBe('approve');
  });

  it('blocks secret-returning commands whatever the access and policy', () => {
    expect(
      call(
        'aws secretsmanager get-secret-value --secret-id s',
        'read-write-approved',
        'require-approval',
      ),
    ).toMatch(/^block: .*secret values/);
  });

  it('blocks a call without a command', () => {
    const d = decide({
      risk: 'write',
      riskFrom: { kind: 'aws-cli', commandArg: 'cli_command' },
      access: 'read-write-approved',
      destructiveActions: 'require-approval',
      guards: [],
      args: {},
      settings: {},
    });
    expect(d.kind).toBe('block');
  });
});
