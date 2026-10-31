# Kodra AI Agent

A self-hosted, customizable AI DevOps agent by [Kodra.io](https://kodra.io).

The agent investigates problems for your team, read-only. Ask it in Slack or the console, or
let an alert start it: it reads your cluster, metrics, dashboards, and pipelines, then tells
you what it found and the likely cause. When a change would help, it proposes one and waits
for your approval. It never changes anything on its own.

You pick what it can read on a static web page, download a small bundle, and run it in your
own environment with your own model key. Shipping code (a Dockerfile, a pipeline, and a Helm
chart in a pull request) waits for your approval too.

> **Status: early release (v0.3.13).** Ready to try with design partners. The product is
> described in [SPEC.md](SPEC.md), and what comes next in [PLAN.md](PLAN.md).

## Get started

You need Docker, a model key (or a local model through Ollama), and access to what the agent
should read, like a kubeconfig or a GitHub token.

1. **Create your agent** at [build.kodra.io/agent](https://build.kodra.io/agent): pick who it
   is for, the model, and the connectors. The page never asks for a key. Download the bundle
   and unzip it.
2. **Set it up.** In the bundle folder (on Linux, first run the line in the bundle README that
   sets `KODRA_AGENT_USER`):

   ```sh
   docker compose run --rm kodra-agent init
   ```

   `init` asks for each key with hidden input, checks it with a read-only call, and writes
   `.env` (owner-only). It also asks you to choose the console admin password.

3. **Start it:** `docker compose up -d`.
4. **Ask it something.** Open the console at http://localhost:8081, sign in as `admin` with
   the password you chose, and ask in **Chat**, for example "what is failing in my
   namespaces?". With Slack set up, mention the app in its channel instead.

On Kubernetes, the bundle's README has the steps (`init --target kubernetes`, then
`helm install`). `docker compose run --rm kodra-agent doctor` checks every connector and says
how to fix what fails.

## What's available

| What       | Available                                                                         |
| ---------- | --------------------------------------------------------------------------------- |
| Connectors | Kubernetes, Prometheus, Grafana, GitHub, GitHub Actions, GitLab, GitLab CI, Slack |
| Connectors | Jenkins, Databases, Docker                                                        |
| Models     | Anthropic, OpenAI, Ollama (Azure OpenAI and AWS Bedrock are coming soon)          |
| Flows      | Ship and onboard (with the Docker connector's build access), and sandbox tests    |

## Try it on a throwaway cluster

`kodra-agent demo` needs only Docker and a model key. It creates a throwaway kind cluster with
three broken workloads, investigates each one read-only, and prints what it found:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock   -e ANTHROPIC_API_KEY ghcr.io/kodra-io/kodra-agent:<version>   demo --provider anthropic --model <model-id>
```

Remove the cluster afterwards with the same command and `demo --cleanup`. A local model works
too (`--provider ollama --model <id> --set baseUrl=http://<host>:11434`). The same scenarios,
ten in all, make up the evaluation suite: see [docs/evals.md](docs/evals.md). The first
report (2026-10-25, `flint:latest` through Ollama, read-only): the right root cause in 10 of
10 scenarios, 9 of 10 passed in full
([report](evals/reports/2026-10-25-ollama-flint-latest.md)).

## Principles

- **Your keys stay with you.** The configurator never asks for secrets. The agent keeps them
  in your environment only. There is no Kodra backend.
- **Safe by default.** Read-only unless you grant more. Every write needs a human approval.
  Destructive actions are blocked.
- **Auditable.** Every model call, tool call, and approval is written to a local audit log,
  with secrets redacted.
- **No telemetry** unless you turn it on.

## Repository layout

```
apps/configurator     static "Create your agent" site (served at build.kodra.io/agent)
apps/agent            runtime and CLI: init, doctor, run, chat, ship
apps/console          web console served by kodra-agent run: status, chat, approvals
packages/schema       kodra-agent.yaml schema, types, secret-reference parser
packages/connectors   connector manifests, registry, dependency rules
packages/templates    bundle templates and ship-flow templates
charts/kodra-agent    Helm chart for the agent
docker                agent image (Dockerfile, MCP server lockfiles)
schema                JSON Schema for kodra-agent.yaml, for editor validation
examples              example kodra-agent.yaml files, and sample apps for the ship flow
```

## Development

Requirements: Node.js 24 LTS (see `.nvmrc`; 22.12 or newer works) and pnpm 12
(`npm i -g pnpm@12`).

```sh
pnpm install
pnpm dev            # configurator at http://localhost:5174/agent/
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e       # browser tests (Playwright, Chromium)
pnpm build
pnpm --filter @kodra-agent/agent cli --help
```

The agent image, the Helm chart, and releases are described in
[docs/packaging.md](docs/packaging.md); the ship flow in [docs/ship.md](docs/ship.md); the web console in
[docs/console.md](docs/console.md).

## Verify a release

Every release image and chart is signed with cosign (keyless, from this repository's GitHub
Actions), and comes with an SPDX SBOM, build provenance, and `SHA256SUMS`.

```sh
# The image and the chart were built by this repository's release workflow.
cosign verify ghcr.io/kodra-io/kodra-agent:0.3.13 \
  --certificate-identity-regexp '^https://github.com/kodra-io/kodra-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/kodra-io/charts/kodra-agent:0.3.13 \
  --certificate-identity-regexp '^https://github.com/kodra-io/kodra-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# The SBOM attached to the image, and the files on the GitHub release.
docker buildx imagetools inspect ghcr.io/kodra-io/kodra-agent:0.3.13 --format '{{ json .SBOM }}'
gh release download v0.3.13 --repo kodra-io/kodra-agent
sha256sum -c SHA256SUMS
```

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). For a review
before you run it, start with the [security review brief](docs/security/review-brief.md).
The agent's metrics, dashboard, alerts, traces, and audit chain are in
[docs/observability.md](docs/observability.md).

## License

[Apache-2.0](LICENSE)
