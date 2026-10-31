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
- **Secrets entered in the console** (a token, or a kubeconfig or SSH key pasted or uploaded)
  go from your browser to the agent only. The agent tests them, then saves them in `.env`, in
  the bundle folder's `secrets/` as owner-only files (Docker Compose), or in its own Secret
  (Kubernetes). They are never shown again. The setup steps the console shows next to each one
  are commands for you to run; nothing runs them for you.
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

Reviewed manifest: `anthropic@9008c5e6a9af`

### OpenAI

- **Sends to:** `https://api.openai.com/v1` (or `baseUrl`), over HTTPS.
- **Secrets:** `apiKey`, sent as a bearer token.
- **Data:** the model input above. OpenAI's data retention terms for your account apply.

Reviewed manifest: `openai@cbc77e01200b`

### Azure OpenAI

Coming soon: cloud model providers are off for now (B4), so no config can select it.

- **Sends to:** your Azure OpenAI `endpoint` and `deployment`, over HTTPS.
- **Secrets:** `apiKey`, sent as the `api-key` header.
- **Data:** the model input above, processed in your Azure tenant and region.

Reviewed manifest: `azure-openai@c4bfe7cdd7c5`

### Amazon Bedrock

Coming soon: cloud model providers are off for now (B4), so no config can select it.

- **Sends to:** the Bedrock runtime endpoint in your `region`, over HTTPS.
- **Secrets:** none in the config: the standard AWS credentials (an IAM role, or AWS keys in the
  environment), signed with SigV4.
- **Data:** the model input above, processed in your AWS account and region.

Reviewed manifest: `bedrock@d78644cb7f87`

### Ollama

- **Sends to:** your Ollama server at `baseUrl`, usually on the same machine or network.
- **Secrets:** none.
- **Data:** the model input above. Nothing leaves your network unless your Ollama server does
  so itself. The strict profile example pins production to a local model this way.

Reviewed manifest: `ollama@3fb5b050c773`

## Connectors

### GitHub

- **Server:** `github/github-mcp-server`, in lockdown mode, with the `repos`, `issues`, and
  `pull_requests` toolsets ([decision](../connectors/github.md)).
- **Sends to:** `https://api.github.com`, over HTTPS.
- **Secrets:** `token` (a fine-grained personal access token), in the server's environment.
- **Reads:** files, commits, branches, issues, and pull requests in the configured `repos`.
- **Ship and onboard (B1):** to choose the pipeline, read only the `.github/workflows` files of
  the other configured `repos` (a shallow, blob-less `git fetch` with the same token as a
  header), and the shared workflow named in `pipelineTemplate` or held in a configured repo.
  Parsed as YAML only: never run and never sent to the model. A value that looks like a
  credential is never copied into the new pull request.
- **Writes, after approval:** branches, files, and pull requests in those repos, never on the
  default branch.

Reviewed manifest: `github@1628ab1cc4f1`

### GitHub Actions

- **Server:** the same `github-mcp-server` binary, with the `actions` toolset.
- **Sends to:** `https://api.github.com`, with the GitHub connector's token.
- **Reads:** workflow runs, jobs, and logs in the configured repos.
- **Runs, reruns, or cancels workflows:** classified destructive, because a workflow can
  deploy. Blocked unless `destructiveActions: require-approval`, and then only after approval.

- **Console dashboard:** The latest workflow runs per repo (status, branch, link), read with the same read tool and shown only in the console. Never sent to the model, and not audited (nothing changes).

Reviewed manifest: `github-actions@98ad5a079546`

### GitLab

- **Server (`server: builtin`, the default):** GitLab's own MCP server, at `<url>/api/v4/mcp`
  over Streamable HTTP, with the core, merge_requests, work_items, and repository toolsets
  ([decision](../connectors/gitlab.md)). Nothing runs in the agent for it. Needs GitLab 19.5
  or newer, with MCP access allowed.
- **Server (`server: community`):** `@zereight/mcp-gitlab` from npm, run in the agent, for
  older GitLab.
- **Sends to:** your GitLab at `url` (`https://gitlab.com` by default), over HTTPS, through the
  agent's proxy and CA settings.
- **Secrets:** `token`: a fine-grained personal access token with the MCP server permission
  (built-in server), sent only as the `Authorization` header; or a personal, project, or group
  access token in the server's environment (community server).
- **Reads:** files, commits, branches, tags, releases, issues and other work items, and merge
  requests in the configured `projects`. Calls that name a project by `url`, or a whole group,
  are refused.
- **Ship and onboard (B1):** to choose the pipeline, read only the `.gitlab-ci.yml` of the other
  configured `projects` (a shallow, blob-less `git fetch` with the same token as a header), and
  the shared template named in `pipelineTemplate` or held in a configured project. Parsed as
  YAML only: never run and never sent to the model. A value that looks like a credential is
  never copied into the new merge request.
- **Writes, after approval:** branches, commits that create or update files, comments, work
  items, and merge requests in those projects, never on the default branch. Never merges,
  approves, forks, deletes, or moves files.

Reviewed manifest: `gitlab@88284449c9cc`

### GitLab CI

- **Server:** the GitLab connector's server, limited to pipeline tools: GitLab's built-in
  server with the ci toolset, or `@zereight/mcp-gitlab` with its pipeline tools.
- **Sends to:** the GitLab connector's `url`, with its token.
- **Reads:** pipelines, jobs, job logs, and job artifacts. CI/CD variable values are never read.
- **Runs, retries, or plays pipelines and jobs:** classified destructive, because a pipeline
  can deploy. Blocked unless `destructiveActions: require-approval`, and then only after
  approval. With the built-in server, only a new pipeline on a listed project: an existing
  pipeline is named by an id no project check covers.
- **Console dashboard:** The latest pipelines per project (status, ref, link), read with the same read tool and shown only in the console. Never sent to the model, and not audited (nothing changes).

Reviewed manifest: `gitlab-ci@92bc1aa18d8b`

### Jenkins

- **Server (`server: plugin`, the default):** the official MCP Server plugin, installed in your
  Jenkins, at `<url>/mcp-server/mcp` over Streamable HTTP ([decision](../connectors/jenkins.md)).
  Nothing runs in the agent for it.
- **Server (`server: community`):** `mcp-jenkins` from PyPI, run in the agent.
- **Sends to:** your Jenkins at `url`, with the configured user and API token, through the
  agent's proxy and CA settings.
- **Secrets:** `token` (a Jenkins API token): sent only as a Basic `Authorization` header to the
  plugin, or passed to `mcp-jenkins` as an environment variable.
- **Reads:** jobs, builds, console logs, test results, and SCM details of the configured `jobs`
  (or under a listed folder); the job list and queue items the token's user can see.
- **Writes, after approval:** stopping a build of a listed job. Starting and rebuilding builds
  (and, with `mcp-jenkins`, answering pipeline inputs) are destructive: blocked unless
  `destructiveActions: require-approval`. Replaying or creating pipelines, Groovy scripts, the
  system log, and job or node config.xml are never exposed.
- **Console dashboard:** the listed jobs and their last result, read with the same read tools
  and shown only in the console. Never sent to the model, and not audited (nothing changes).

Reviewed manifest: `jenkins@a77a9cef8a36`

### Docker

- **Server:** none. `ship` runs the `docker` CLI against the Docker socket.
- **Sends to:** the local Docker daemon at `socketPath`. Building may pull base images from
  their registries (or your mirrors, `spec.network.baseImageMirrors`).
- **Secrets:** none.
- **Writes, after approval:** builds and runs the image `ship` creates, then removes it. With
  Compose, only the one-shot `kodra-builder` service mounts the socket.

Reviewed manifest: `docker@41c1c3542fc5`

### Kubernetes

- **Server:** `containers/kubernetes-mcp-server` ([decision](../connectors/kubernetes.md)).
- **Sends to:** your cluster's API server, from the kubeconfig (or the in-cluster service
  account).
- **Secrets:** `kubeconfig` (a file). EKS kubeconfigs get their token from the image's
  `aws eks get-token`, signed locally, with the AWS keys in the agent's environment. They
  only sign that token: no AWS API is called.
- **Reads:** pods, logs, events, deployments, and other resources in the configured
  `namespaces`. The server's config refuses Secrets, ServiceAccounts, and RBAC objects.
- **Writes, after approval:** scaling deployments in those namespaces, never the agent's own
  objects. The write role grants only get and update on `deployments/scale` (L2). Creating, changing, deleting, and exec are classified destructive: blocked unless
  `destructiveActions: require-approval`.
- **Sandbox tests, after approval (B2):** with `sandbox` set and read-write-approved access,
  the agent runs Helm (with the same kubeconfig, as `KUBECONFIG` in a 0600 temp file, and
  the AWS keys as `AWS_*`) to install a branch's CI image with its chart in that one
  namespace, calls it through the API server's service proxy, and uninstalls it. Helm keeps
  its records in ConfigMaps, so the sandbox Role has no access to Secrets. Secrets the code
  reads get placeholder values; real test values come from a `<app>-sandbox-env` Secret the
  team makes, which the agent never reads. Only names, the image, and pass or fail go to
  the audit log and Slack. Nothing is sent to the model. See [sandbox](../sandbox.md).

- **Console dashboard:** Pod states, deployment readiness, and warning events per namespace, and the pods of each workload listed in `databases` (`namespace/name`, in a configured namespace; the **Database pods** card), read with the same read tools and shown only in the console. Never sent to the model, and not audited (nothing changes).

Reviewed manifest: `kubernetes@af7bb317d853`

### Prometheus

- **Server:** `prometheus-mcp-server` from PyPI ([decision](../connectors/prometheus.md)).
- **Sends to:** your Prometheus at `url`, and Alertmanager at `alertmanagerUrl` for firing
  alerts (polled every `pollIntervalSeconds`).
- **Secrets:** `bearerToken`, optional.
- **Reads only:** queries, targets, and alerts.

Reviewed manifest: `prometheus@622328c0bab1`

### Grafana

- **Server:** `grafana/mcp-grafana` ([decision](../connectors/grafana.md)).
- **Sends to:** your Grafana at `url`, and through it the data sources it queries.
- **Secrets:** `serviceAccountToken`.
- **Reads only:** dashboards, data source queries, and alert rules. The server runs with
  `--disable-write` and `--usage-stats=disabled`.

Reviewed manifest: `grafana@c52161cc90f7`

### AWS

Coming soon: the connector cannot be enabled for now ([why](../connectors/aws.md)). When it
comes back, it works like this:

- **Servers:** `awslabs.eks-mcp-server` and `awslabs.cloudwatch-mcp-server` from PyPI, each
  only when listed in `services` ([decision](../connectors/aws.md)).
- **Sends to:** AWS APIs in your `region`, over HTTPS, signed with SigV4.
- **Secrets:** `accessKeyId` and `secretAccessKey`, or the standard AWS credentials (an IAM
  role) when they are left out.
- **Reads only:** EKS clusters and resources, CloudWatch metrics, logs, and alarms. Sensitive
  data access and writes are turned off in the servers.

Reviewed manifest: `aws@dde614ac59ad`

### Databases

- **Server:** none; a built-in server inside the agent ([decision](../connectors/databases.md)).
  Drivers `mysql2` and `pg`, and `ssh2` for tunnels, pinned.
- **Sends to:** each listed database at its `host` and `port`, directly or through an SSH
  tunnel to `tunnelHost` (whose host key must match `tunnelHostKey`). Encrypted and the
  certificate checked by default (`tls: verify`).
- **Secrets:** each database's `password` and `tunnelKey`, only in variables named for it
  (`KODRA_DB_<NAME>_PASSWORD`, `KODRA_DB_<NAME>_TUNNEL_KEY`) or a file. A reference to any other
  variable is refused, so no other secret can be sent to a database host. Each goes only to its
  own database or bastion.
- **Reads only:** fixed status queries (version, uptime, connections, read-only, replica lag).
  No tool takes SQL; nothing in the data is read.
- **Console dashboard:** each database's state, version, connections, and lag, from the same
  read tool, shown only in the console and on Overview. Not audited (nothing changes).

Reviewed manifest: `databases@41bdf113f15c`

### Slack

- **Server:** none. The agent uses Slack Bolt in Socket Mode ([decision](../connectors/slack.md)).
- **Sends to:** `slack.com` over a WebSocket and HTTPS. No inbound connection is needed.
- **Secrets:** `botToken` and `appToken`.
- **Data:** questions from your channel, answers, alert findings, and approval requests (tool,
  arguments, and reason, redacted and masked). Anyone in the channel can read them, and your
  Slack workspace's retention settings apply.

Reviewed manifest: `slack@060f3a1a396d`
