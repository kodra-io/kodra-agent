# Kubernetes connector

**Server:** [`containers/kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server) v0.0.67
**Decided:** 2026-10-02, for M4

## Why this server

| Check       | Finding                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| License     | Apache-2.0                                                                                                                        |
| Maintenance | Active: commits daily, releases every few weeks (v0.0.67 on 2026-09-18), about 2.1k stars, backed by the Red Hat `containers` org |
| Runtime     | A single Go binary per platform; no runtime to install in the image                                                               |
| Controls    | `--read-only`, a TOML config with a tool allowlist (`enabled_tools`) and refused resource kinds (`denied_resources`)              |
| Telemetry   | None found in the docs or flags                                                                                                   |

Considered: `Flux159/mcp-server-kubernetes` (MIT, TypeScript, active). It works, but it needs Node and kubectl in the image, and it has no per-tool allowlist or denied-kinds setting, so the policy engine would be the only control.

## Pinning

Release binaries for linux-x64, linux-arm64, darwin-arm64, and win32-x64, pinned by SHA-256 in the manifest. The project publishes no checksum file, so the hashes were computed from the release assets on 2026-10-02. `pnpm mcp:fetch` refuses a binary whose hash does not match.

## How it runs

```
kubernetes-mcp-server --toolsets core --disable-multi-cluster --stateless \
  [--read-only]                                   # access: read-only
  [--kubeconfig <0600 temp file> --cluster-provider kubeconfig]   # when a kubeconfig secret is set
  --config <0600 temp file>
```

Without a kubeconfig secret the server auto-detects: the in-cluster service account (it receives only `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`, and `KUBECONFIG` from the agent's environment), or `~/.kube/config` on a workstation.

The config file allows only seven tools and refuses Secrets, ServiceAccounts, and RBAC objects even if a Role would allow them:

```toml
toolsets = ["core"]
enabled_tools = ["events_list", "pods_get", "pods_list_in_namespace", "pods_log",
                 "resources_get", "resources_list", "resources_scale"]
# [[denied_resources]] Secret, ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding
```

## Tool classification

Every tool in the `core` toolset at v0.0.67 (from `listTools` on the real binary):

| Tool                                                                                                         | Risk        | Exposed         | Notes                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `events_list`, `pods_get`, `pods_list_in_namespace`, `pods_log`, `resources_get`, `resources_list`           | read        | yes             | `namespace` must be one of the configured namespaces (guard)                                                                                    |
| `resources_scale`                                                                                            | write       | read-write only | The server marks it destructive, so `--disable-destructive` cannot be used; the allowlist and policy engine control it instead                  |
| `namespaces_list`, `nodes_log`, `nodes_stats_summary`, `nodes_top`, `pods_list`, `pods_top`, `projects_list` | read        | no              | Cluster-wide or no namespace argument; a namespace-scoped Role cannot serve them                                                                |
| `pods_exec`, `pods_run`, `pods_delete`, `resources_delete`, `resources_create_or_update`                     | destructive | no              | Arbitrary commands, images, deletes, and free-form object changes. Note: the server gives `pods_run` neither a read-only nor a destructive hint |

The `config` toolset is never enabled: its `configuration_view` tool returns the kubeconfig itself.

## Tested

`pnpm test:kind` creates a kind cluster with a crashlooping deployment and drives this server through `kodra-agent chat`: read-only investigation, an approved scale, and a blocked read in `kube-system`.

## EKS clusters

A kubeconfig from `aws eks update-kubeconfig` has no token in it. It runs
`aws --region <region> eks get-token --cluster-name <name>` each time a client connects. The
agent image has no AWS CLI (it would add about 200 MB). It ships its own `aws` command, which
does only `eks get-token` and refuses everything else (`apps/agent/src/eks-token.ts`,
`docker/aws`). The kubeconfig stays as it is, and both the agent's own client (`init`, `doctor`)
and this MCP server use it.

- **Token:** a presigned STS `GetCallerIdentity` URL, with the cluster name in a signed
  `x-k8s-aws-id` header, encoded as `k8s-aws-v1.` plus unpadded base64url. It is valid for 15
  minutes; the agent reports 14. Checked against aws-iam-authenticator `pkg/token/token.go`
  (October 2026). A unit test recomputes the SigV4 signature from the AWS spec.
- **Options:** `--cluster-name`, `--region` (or `AWS_REGION`), `--role-arn` (assumed first),
  `--profile` (or `AWS_PROFILE`), and `--output json`.
- **Credentials:** the standard AWS chain: environment variables, `~/.aws` profiles including
  SSO, web identity, and instance roles. This server inherits the `AWS_*` variables for it,
  and the values of the secret ones are registered with the redactor.
- **Running `init` from the image:** the bundle README has an EKS variant of the command that
  also mounts `~/.aws` read-only and passes `AWS_PROFILE`. With SSO, run `aws sso login` first,
  because the mount is read-only.
- **Inside the cluster** none of this is used: the agent uses its service account token.
- **Tested** against a real EKS cluster: `doctor` listed pods, and this server answered a read,
  both through the built-in `aws eks get-token`.

GKE's `gke-gcloud-auth-plugin` and other login helpers are not in the image; use
`init --dry-run` for those clusters.
