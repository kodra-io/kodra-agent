# Networks: proxies, private CAs, OpenShift, and NetworkPolicy

How to run the agent where outbound traffic goes through a proxy, TLS is inspected with an
internal CA, images come from a private registry, or pods run under OpenShift's restricted
SCC (PLAN-v0.2 M12).

## Proxy and CA certificates

```yaml
spec:
  network:
    proxy:
      https: ${env:HTTPS_PROXY} # a reference: proxy URLs can hold a user and password
      http: ${env:HTTP_PROXY} # optional
      noProxy: 'git.internal,.corp' # added to localhost, 127.0.0.1, ::1, .svc, .cluster.local
    caBundleFile: /etc/kodra-agent/ca/ca.pem
```

- Put the proxy URL in `.env` (Docker Compose) or the agent's Secret (Kubernetes), like any
  other secret. The agent registers it with the redactor, so a password in it never reaches
  logs, the audit log, Slack, the console, or the model. `doctor` shows only the proxy's
  host and port.
- On Kubernetes, the API server's address (`KUBERNETES_SERVICE_HOST`) always skips the proxy.
- `caBundleFile` is a PEM file of extra CA certificates: a TLS-inspecting proxy's CA, or an
  internal CA, or Amazon RDS's. On Docker Compose, upload it in the console (Settings,
  Network, Trusted certificates: saved as `ca/console-ca-bundle.pem` and pointed at, then the
  agent restarts), or put it in the bundle folder yourself (for example `ca/ca.pem`, read at
  `/etc/kodra-agent/ca/ca.pem`). On Kubernetes, set `caBundle.configMap` (or
  `caBundle.secret`) and `caBundle.key` in the chart's values: it is mounted at
  `/etc/kodra-agent-ca/<key>`, so point `caBundleFile` there.

### What uses it

The agent applies the settings to its own process at startup, before any connection
(Node.js 24.14 or newer, which the image has):

- `http.setGlobalProxyFromEnv` routes `fetch()` and `http(s)` requests through the proxy. That
  covers model calls, connection checks, the console's checks, and Slack (Bolt's Web API calls
  and its Socket Mode WebSocket).
- `tls.setDefaultCACertificates` adds the extra CAs to Node's roots for every TLS client.

Child processes get the same settings as environment variables, in the forms each one reads:

| Variable                                                                                   | Read by                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, and lower-case copies                             | Go and Python MCP servers, git (curl reads only `http_proxy` lower-case), helm, docker |
| `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` (the extra file)                             | Node MCP servers                                                                       |
| `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` | Go, Python, the AWS SDK, curl, git                                                     |

Go and Python replace their roots with the file they are given rather than adding to them,
so those variables point at a combined file the agent writes at startup: Node's default roots
plus your extra certificates. `docker build` in the ship flow gets `HTTPS_PROXY`, `HTTP_PROXY`,
and `NO_PROXY` as build arguments by name only, so docker reads the values from the
environment and a password never appears in the arguments.

`doctor` checks that each proxy variable is set, that the CA file holds PEM certificates, and
that this Node.js can apply both; its connection checks then run through the proxy.

CI proves it: `pnpm test:proxy` runs the agent image on a network whose only way out is
mitmproxy with its own CA. `doctor`, Slack (Web API and Socket Mode), an alert investigation
whose model calls a Python MCP server (Prometheus) and a Go one (Grafana), git, and helm all
have to reach their stand-ins through it.

## Private registries

- **The agent image.** Docker Compose: set `KODRA_AGENT_IMAGE` in `.env` to your copy, like
  `harbor.example.com/mirror/kodra-io/kodra-agent:0.3.12`. Helm: set `image.registry`, which
  replaces the registry host (`harbor.example.com/mirror` gives
  `harbor.example.com/mirror/kodra-io/kodra-agent`).
- **Base images in the ship flow.** Generated Dockerfiles and CI pull pinned base images.
  Map each registry to its mirror, and the tags and digests stay as pinned:

  ```yaml
  spec:
    ship:
      baseImageMirrors:
        docker.io: harbor.example.com/dockerhub-proxy # node:24 -> .../library/node:24
        gcr.io: harbor.example.com/gcr-proxy
  ```

See `docs/air-gapped.md` for a cluster with no internet access at all.

## OpenShift

The image runs under any user id in group 0: everything it writes belongs to group 0 and is
group-writable, and `HOME` is set. In the chart, set `openshift: true` so `runAsUser`,
`runAsGroup`, and `fsGroup` are left for the restricted SCC to choose. CI runs the image as
`--user 1000680000:0` with a read-only root filesystem.

## NetworkPolicy

The chart creates a NetworkPolicy for the agent pod, worked out from `kodra-agent.yaml`. It is
on for the `team` and `strict` profiles and off for `starter`; `networkPolicy.enabled` sets it
either way. It allows:

- DNS (`kube-dns`);
- the API server: found with `helm lookup`, or set `networkPolicy.apiServer.cidr` and `port`
  for `helm template` and GitOps;
- in-cluster services named in connector URLs, by namespace and port. A URL counts as
  in-cluster when its host is `<service>.<namespace>.svc[.cluster.local]`, or
  `<service>.<namespace>` when the last part is not a public domain; use the `.svc` form to be
  certain;
- then either the proxy alone, when `spec.network.proxy` is set (give its address as
  `networkPolicy.proxy.cidr` and `port`), or HTTPS to public addresses with private and
  link-local ranges blocked;
- anything in `networkPolicy.extraEgress`, as written.

A standard NetworkPolicy cannot match hostnames. With Cilium, set `networkPolicy.cilium: true`
for a CiliumNetworkPolicy that allows HTTPS only to the hostnames the config uses: the model
provider, GitHub, GitLab, Slack (`slack.com`, `*.slack.com`), AWS Bedrock (`*.amazonaws.com`), and any
other connector URL outside the cluster.
