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
