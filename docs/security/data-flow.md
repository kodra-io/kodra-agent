# Data flow

Where your data goes, for each connector and model provider. Kodra.io runs no backend: the
agent talks only to the services you configure, from your own environment.

Every entry ends with the manifest it was reviewed against. `src/data-flow.test.ts` in
`packages/connectors` fails when a manifest changes (a new tool, server version, secret, or
setting) and its entry here was not reviewed and updated in the same change.

## What every connection has in common

- **Secrets** are read from your environment (`.env`, a Kubernetes Secret, or a file) when the
  agent starts. They go only to the service they belong to, in an environment variable or a
  file with owner-only permissions, never on a command line. They never reach the model,
  Slack, the console, logs, metrics, traces, or the audit log: the redactor masks them, and
  `src/canary.test.ts` and `src/canary-model.test.ts` fail if one gets through.
- **MCP servers** run as child processes inside the agent container, each in an empty private
  folder, with a minimal environment plus only its own connector's secrets. Their binaries and
  packages are pinned by version and SHA-256 and preinstalled in the image.
- **Tool output** goes to the model as untrusted data, after secrets are redacted and customer
  data is masked (`spec.dataProtection`, see [data protection](../data-protection.md)).
- **The audit log** stays on the agent's volume. It records who asked for what, which tools
  ran, decisions, and token counts, redacted and masked.
- **Metrics and traces** carry counts, durations, and labels from fixed lists only, and go only
  where you send them (see [observability](../observability.md)).

## Model providers

The model receives the system prompt, the conversation (questions, earlier answers), tool
definitions, and tool output, all redacted and masked. With `spec.models` and
`environments[].model`, data from an environment goes only to the model pinned to it.

### Anthropic

- **Sends to:** `https://api.anthropic.com` (or `baseUrl`), over HTTPS.
- **Secrets:** `apiKey` (`ANTHROPIC_API_KEY`), sent as the `x-api-key` header.
- **Data:** the model input above. Anthropic's data retention terms for your account apply.

Reviewed manifest: `anthropic@5e90383fd109`

### OpenAI

- **Sends to:** `https://api.openai.com/v1` (or `baseUrl`), over HTTPS.
- **Secrets:** `apiKey`, sent as a bearer token.
- **Data:** the model input above. OpenAI's data retention terms for your account apply.

Reviewed manifest: `openai@33fd99730eff`

### Azure OpenAI

- **Sends to:** your Azure OpenAI `endpoint` and `deployment`, over HTTPS.
- **Secrets:** `apiKey`, sent as the `api-key` header.
- **Data:** the model input above, processed in your Azure tenant and region.

Reviewed manifest: `azure-openai@f55b96df22ef`

### Amazon Bedrock

- **Sends to:** the Bedrock runtime endpoint in your `region`, over HTTPS.
- **Secrets:** none in the config: the standard AWS credentials (an IAM role, or AWS keys in the
  environment), signed with SigV4.
- **Data:** the model input above, processed in your AWS account and region.

Reviewed manifest: `bedrock@f23c84d59f32`

### Ollama

- **Sends to:** your Ollama server at `baseUrl`, usually on the same machine or network.
- **Secrets:** none.
- **Data:** the model input above. Nothing leaves your network unless your Ollama server does
  so itself. The strict profile example pins production to a local model this way.

Reviewed manifest: `ollama@86010b375609`

## Connectors

### GitHub

- **Server:** `github/github-mcp-server`, in lockdown mode, with the `repos`, `issues`, and
  `pull_requests` toolsets ([decision](../connectors/github.md)).
- **Sends to:** `https://api.github.com`, over HTTPS.
- **Secrets:** `token` (a fine-grained personal access token), in the server's environment.
- **Reads:** files, commits, branches, issues, and pull requests in the configured `repos`.
- **Writes, after approval:** branches, files, and pull requests in those repos, never on the
  default branch.

Reviewed manifest: `github@dbd071da3c11`

### GitHub Actions

- **Server:** the same `github-mcp-server` binary, with the `actions` toolset.
- **Sends to:** `https://api.github.com`, with the GitHub connector's token.
- **Reads:** workflow runs, jobs, and logs in the configured repos.
- **Runs, reruns, or cancels workflows:** classified destructive, because a workflow can
  deploy. Blocked unless `destructiveActions: require-approval`, and then only after approval.

Reviewed manifest: `github-actions@55c971450379`

### GitLab

- **Server:** `@zereight/mcp-gitlab` from npm ([decision](../connectors/gitlab.md)).
- **Sends to:** your GitLab at `url` (`https://gitlab.com` by default), over HTTPS.
- **Secrets:** `token` (a personal, project, or group access token).
- **Reads:** files, commits, branches, issues, and merge requests in the configured `projects`.
- **Writes, after approval:** branches, files, and merge requests in those projects, never on
  the default branch.

Reviewed manifest: `gitlab@15e1cd27df2b`

### GitLab CI

- **Server:** the same `@zereight/mcp-gitlab` package, limited to pipeline tools.
- **Sends to:** the GitLab connector's `url`, with its token.
- **Reads:** pipelines, jobs, and job logs.
- **Creates, retries, or plays pipelines and jobs:** classified destructive, because a pipeline
  can deploy. Blocked unless `destructiveActions: require-approval`, and then only after
  approval.

Reviewed manifest: `gitlab-ci@3e6118bf64af`

### Docker

- **Server:** none. `ship` runs the `docker` CLI against the Docker socket.
- **Sends to:** the local Docker daemon at `socketPath`. Building may pull base images from
  their registries (or your mirrors, `spec.network.baseImageMirrors`).
- **Secrets:** none.
- **Writes, after approval:** builds and runs the image `ship` creates, then removes it. With
  Compose, only the one-shot `kodra-builder` service mounts the socket.

Reviewed manifest: `docker@34bd0adb3e3c`

### Kubernetes

- **Server:** `containers/kubernetes-mcp-server` ([decision](../connectors/kubernetes.md)).
- **Sends to:** your cluster's API server, from the kubeconfig (or the in-cluster service
  account).
- **Secrets:** `kubeconfig` (a file). EKS kubeconfigs get their token from the image's
  `aws eks get-token`, signed locally.
- **Reads:** pods, logs, events, deployments, and other resources in the configured
  `namespaces`. The server's config refuses Secrets, ServiceAccounts, and RBAC objects.
- **Writes, after approval:** scaling deployments in those namespaces, never the agent's own
  objects. Creating, changing, deleting, and exec are classified destructive: blocked unless
  `destructiveActions: require-approval`.

Reviewed manifest: `kubernetes@7ec08be6d8cf`

### Prometheus

- **Server:** `prometheus-mcp-server` from PyPI ([decision](../connectors/prometheus.md)).
- **Sends to:** your Prometheus at `url`, and Alertmanager at `alertmanagerUrl` for firing
  alerts (polled every `pollIntervalSeconds`).
- **Secrets:** `bearerToken`, optional.
- **Reads only:** queries, targets, and alerts.

Reviewed manifest: `prometheus@3f1aa025d61c`

### Grafana

- **Server:** `grafana/mcp-grafana` ([decision](../connectors/grafana.md)).
- **Sends to:** your Grafana at `url`, and through it the data sources it queries.
- **Secrets:** `serviceAccountToken`.
- **Reads only:** dashboards, data source queries, and alert rules. The server runs with
  `--disable-write` and `--usage-stats=disabled`.

Reviewed manifest: `grafana@b7a337946901`

### AWS

- **Servers:** `awslabs.eks-mcp-server` and `awslabs.cloudwatch-mcp-server` from PyPI, each
  only when listed in `services` ([decision](../connectors/aws.md)).
- **Sends to:** AWS APIs in your `region`, over HTTPS, signed with SigV4.
- **Secrets:** `accessKeyId` and `secretAccessKey`, or the standard AWS credentials (an IAM
  role) when they are left out.
- **Reads only:** EKS clusters and resources, CloudWatch metrics, logs, and alarms. Sensitive
  data access and writes are turned off in the servers.

Reviewed manifest: `aws@7a940bcd91bd`

### Slack

- **Server:** none. The agent uses Slack Bolt in Socket Mode ([decision](../connectors/slack.md)).
- **Sends to:** `slack.com` over a WebSocket and HTTPS. No inbound connection is needed.
- **Secrets:** `botToken` and `appToken`.
- **Data:** questions from your channel, answers, alert findings, and approval requests (tool,
  arguments, and reason, redacted and masked). Anyone in the channel can read them, and your
  Slack workspace's retention settings apply.

Reviewed manifest: `slack@5fad394de57a`
