# AWS connector

**Server:** [`awslabs/mcp`](https://github.com/awslabs/mcp): `awslabs.aws-api-mcp-server` 1.5.6 (PyPI)
**Decided:** 2026-10-30, for B4. Replaces `awslabs.eks-mcp-server` and `awslabs.cloudwatch-mcp-server` (M4b).

## Why this server

| Check       | Finding                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License     | Apache-2.0                                                                                                                                                 |
| Maintenance | AWS Labs' official server, released every few weeks (1.5.6 on 2026-09-30; 1.6.0 on 2026-10-27 is too new for the release-age rule). About 10k stars        |
| Runtime     | Python, installed from a hash-locked file (`docker/mcp/pypi/awslabs.aws-api-mcp-server.txt`). It bundles awscli 1.46.0 and runs it in-process              |
| Controls    | `READ_OPERATIONS_ONLY=true` refuses anything AWS does not list as a read. `AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS=no-access` refuses local files |
| Telemetry   | On by default (`AWS_API_MCP_TELEMETRY`). The manifest sets it to `false`                                                                                   |

One server covers every AWS service, so EKS, EC2, ECS, ECR, CloudWatch metrics, logs, and alarms,
and the rest come through one connector, and the model sees one tool instead of about thirty.

**Not the managed AWS MCP Server.** Its `aws___run_script` runs arbitrary Python, which the
policy engine cannot classify. AWS says the API MCP Server is "entering end of development" in
favor of the managed one; when that changes what we can pin, this decision is reviewed.

## How it runs

```
awslabs.aws-api-mcp-server   (from the preinstalled, hash-locked venv)
```

Environment:

- `AWS_REGION` from the `region` setting, the connector's optional `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`, and, when set, the variables the AWS credential chain uses for IRSA
  and container credentials (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, …).
- `AWS_API_MCP_TELEMETRY=false`, `AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS=no-access`,
  `AWS_API_MCP_SUPPRESS_DEPRECATION_WARNING=true`, `FASTMCP_LOG_LEVEL=ERROR`.
- Read-only access adds `READ_OPERATIONS_ONLY=true` (the manifest's `accessEnv`).

**Network:** besides the AWS APIs in your region, read-only mode fetches AWS's list of read
operations from `https://servicereference.us-east-1.amazonaws.com/` when the server starts. Behind
a proxy, allow that host too.

## Tool classification

From `listTools` on the real server:

| Tool                   | Risk                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `call_aws`             | Per command (`riskFrom`): read, write, or destructive, decided by the agent on each call |
| `suggest_aws_commands` | Hidden. It sends the question to an AWS endpoint (`api-mcp.global.api.aws`)              |

`call_aws` takes one AWS CLI command (`cli_command`). The manifest classifies it `write` and
names `riskFrom: { kind: 'aws-cli', commandArg: 'cli_command' }`, so `apps/agent/src/aws/cli-risk.ts`
reads each call's command:

- **Read:** a command AWS's own metadata lists as read-only (`apps/agent/src/aws/read-operations.json`,
  generated from the pinned server by `apps/agent/scripts/aws-read-operations.py`), `wait`, and
  `aws s3 ls`. Reads run.
- **Destructive:** a command that starts with delete, terminate, remove, deregister, purge,
  revoke, destroy, release, or abort (also after `batch-`), and `aws s3 rm`, `mv`, `rb`.
  Blocked unless `policy.destructiveActions` is `require-approval`, then it needs approval.
- **Write:** everything else. Needs approval, and read-write access.
- **Blocked always:**
  - Commands that return a secret value or a credential: `secretsmanager get-secret-value`,
    `kms decrypt`, `sts assume-role`, `ecr get-login-password`, `rds generate-db-auth-token`,
    `ssm get-parameter --with-decryption`, `s3 presign`, and the rest of the list in
    `cli-risk.ts`. AWS's own read-only mode allows several of these (their access level is not
    Write), so the agent blocks them itself. The IAM policy below denies them too.
  - Anything but one plain `aws <service> <command>`: pipes, redirects, `$`, backticks.
  - `--profile`, `--endpoint-url`, `--no-verify-ssl`, `--ca-bundle`, `--no-sign-request`,
    `--debug`, and `file://` or `fileb://` arguments.
  - Local CLI commands: `configure`, `login`, `logout`, `sso`, `history`, `help`.

A read-only connector still offers `call_aws` (it can always read), never `propose_change`.

## IAM

For read-only access, the setup steps create an IAM user with the AWS managed policy
`ReadOnlyAccess` and an inline policy that denies `secretsmanager:GetSecretValue`,
`secretsmanager:BatchGetSecretValue`, `kms:Decrypt`, and `ssm:GetParameter*`. For read-write
access, attach only the write actions the agent may use.

**Cost note:** CloudWatch Logs Insights queries are billed by AWS for the data they scan. The
permission summary says so.

## Upgrading from 0.3.x

The `services` setting (`eks`, `cloudwatch`) is retired: a config that still sets it loads, and
the value is ignored. The old IAM policy (EKS and CloudWatch reads) keeps working for those
services; other services need `ReadOnlyAccess` or your own read policy.
