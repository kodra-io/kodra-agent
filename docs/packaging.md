# Packaging and release

## The agent image

`docker/Dockerfile` builds `ghcr.io/kodra-io/kodra-agent` from the repo root:

```sh
docker build -f docker/Dockerfile -t ghcr.io/kodra-io/kodra-agent:dev .
```

- **Base:** `node:24.21.0-trixie-slim`. Debian, not Alpine: the Python MCP servers depend on
  native wheels (pydantic-core and others) that are published for glibc.
- **The agent** runs from its TypeScript source with Node's type stripping. Only production
  dependencies are installed, from `pnpm-lock.yaml`.
- **MCP servers are preinstalled**, so the agent starts them without downloading anything:
  release binaries are checked against the SHA-256 in their manifest, PyPI servers install
  from hash-locked requirements (`uv pip install --require-hashes --no-deps`), and npm
  servers install from their `package-lock.json` (`npm ci --ignore-scripts`). The lockfiles
  live in `docker/mcp`. A test fails if one is missing or pins a version other than the
  manifest's. The launcher prefers a preinstalled server, and falls back to `uvx` or `npx`
  outside the image.
- **Tools for the ship flow:** git (Debian), the Docker CLI (`docker:29.8.2-cli`), and Helm
  (`alpine/helm:4.3.0`), copied from pinned images.
- **Runs as** `kodra` (uid 10001). Caches go to `/tmp`, so the root filesystem can be
  read-only. The health check calls `/healthz` on port 8080.
- **Size:** about 1.7 GB unpacked. Most of it is the three Python server environments (the
  AWS servers bring boto3) and the Node.js runtime.

To update a PyPI server: change its version in the connector manifest, then regenerate its
lockfile:

```sh
echo "prometheus-mcp-server==<version>" > /tmp/in.txt
uv pip compile /tmp/in.txt --universal --python-version 3.13 --generate-hashes --no-header -o docker/mcp/pypi/prometheus-mcp-server.txt
```

For an npm server, change the version in `docker/mcp/npm/<name>/package.json` and run
`npm install --package-lock-only --ignore-scripts` in that folder.

## The Helm chart

`charts/kodra-agent` takes the `values.yaml` from a Kubernetes bundle as is:

```sh
helm install my-agent oci://ghcr.io/kodra-io/charts/kodra-agent --version 0.1.0 \
  --namespace kodra-agent -f values.yaml --set-file config=kodra-agent.yaml
```

- The config goes into a ConfigMap; a changed config restarts the pod.
- `existingSecret` (created by `kodra-agent init --target kubernetes`) becomes environment
  variables; `fileSecrets` are mounted read-only from it.
- One replica with the `Recreate` strategy: two agents would answer Slack twice.
- Restricted pod security: non-root, read-only root filesystem with an `emptyDir` for `/tmp`,
  no privilege escalation, all capabilities dropped, `RuntimeDefault` seccomp.
- `rbac.create` (off by default) creates the same namespace-scoped Role and RoleBinding as the
  bundle's `rbac.yaml`; `rbac.write` adds patch on deployments.
- `persistence.enabled` keeps the audit log on a PersistentVolumeClaim.

## Checks

- `pnpm test:package` (CI job `package`) runs on a built image: every preinstalled server
  starts with no network and a read-only root filesystem, a generated compose bundle runs
  `init --non-interactive` and `up` and answers `/healthz` and `/readyz`, and the chart
  installs on a throwaway kind cluster with the bundle's values and becomes ready.
- `src/release.test.ts` keeps the CLI, bundle, and chart versions equal, checks that the chart
  accepts every value the bundle sets, and that the Dockerfile pins every image.

## Releasing

1. Set the new version in `apps/agent/package.json`, `charts/kodra-agent/Chart.yaml`
   (`version` and `appVersion`), and `AGENT_VERSION` in `packages/templates/src/bundle.ts`.
   `src/release.test.ts` fails until all of them match.
2. Merge to `main`, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The `Release` workflow builds the image for linux/amd64 and linux/arm64 with SBOM and
   provenance attestations, pushes it and the chart to GHCR, signs both with cosign
   (keyless), and creates the GitHub release with the chart, an SPDX SBOM, and `SHA256SUMS`.
4. GHCR packages start private: make `kodra-agent` and `charts/kodra-agent` public in the
   organization's package settings after the first release.

Verify a release:

```sh
cosign verify ghcr.io/kodra-io/kodra-agent:0.1.0 \
  --certificate-identity-regexp '^https://github.com/kodra-io/kodra-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
