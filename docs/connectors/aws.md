# AWS connector

**Servers:** [`awslabs/mcp`](https://github.com/awslabs/mcp): `awslabs.eks-mcp-server` 0.2.1 and `awslabs.cloudwatch-mcp-server` 0.3.1 (PyPI)
**Decided:** 2026-10-03, for M4b

## Why these servers

| Check       | Finding                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| License     | Apache-2.0                                                                                                                                   |
| Maintenance | AWS Labs' official servers: releases every few weeks (EKS 0.2.1 on 2026-09-08, CloudWatch 0.3.1 on 2026-09-22), about 10k stars for the repo |
| Runtime     | Python, run with `uvx` at pinned versions, like the Prometheus connector. M7 installs them from a lock file                                  |
| Controls    | EKS: `--allow-write` and `--allow-sensitive-data-access`, both off by default and passed off explicitly. CloudWatch: read-focused            |
| Telemetry   | None found in the package descriptions                                                                                                       |

One connector runs both servers (the manifest's `runtime` is a list). Their tool names do not overlap; the host refuses to start if they ever do.

## Scope: EKS and CloudWatch, not ECR

Neither server covers ECR (container images). AWS's generic `aws-api-mcp-server` can run _any_ AWS CLI command, which is too broad to classify, so ECR waits for a narrower server. The connector's description and permission summary say EKS and CloudWatch only.

## How it runs

```
uvx --from awslabs.eks-mcp-server==0.2.1 awslabs.eks-mcp-server --no-allow-write --no-allow-sensitive-data-access
uvx --from awslabs.cloudwatch-mcp-server==0.3.1 awslabs.cloudwatch-mcp-server
```

Environment: `AWS_REGION` (config), the connector's optional `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, and, when set, the variables the AWS credential chain uses for IRSA and container credentials (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, …). `FASTMCP_LOG_LEVEL=ERROR`.

## Tool classification

From `listTools` on both real servers:

| Server     | Tools                                                                                                                                                                                                | Risk                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| EKS        | `get_cloudwatch_logs`, `get_cloudwatch_metrics`, `get_eks_insights`, `get_eks_metrics_guidance`, `get_eks_vpc_config`, `get_policies_for_role`, `list_api_versions`, `search_eks_troubleshoot_guide` | read                                                                                                                   |
| EKS        | `add_inline_policy`, `apply_yaml`, `generate_app_manifest`, `manage_eks_stacks`, `manage_k8s_resource`                                                                                               | destructive. The server offers them even without `--allow-write` (and refuses them); the policy engine blocks them too |
| CloudWatch | 18 reads: alarms, metrics, log groups, Logs Insights, PromQL, index recommendations                                                                                                                  | read                                                                                                                   |
| CloudWatch | `cancel_logs_insight_query`                                                                                                                                                                          | write                                                                                                                  |

**Hidden:** `get_k8s_events`, `get_pod_logs`, and `list_k8s_resources`. They reach pods through AWS credentials, which would bypass the Kubernetes connector's namespace limits; pods go through the Kubernetes connector instead.

**Cost note:** CloudWatch Logs Insights queries are billed by AWS for the data they scan. The permission summary says so.
