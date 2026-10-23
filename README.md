# Kodra AI Agent

A self-hosted, customizable AI DevOps agent by [Kodra.io](https://kodra.io).

You pick what the agent can do on a static web page, download a small bundle, and run it in
your own environment with your own model key. The agent builds, containerizes, packages, and
ships code, then watches your monitoring and works with your team in Slack. It asks for
approval before it changes anything.

> **Status: early release (v0.3.8).** Ready to try with design partners. The product is
> described in [SPEC.md](SPEC.md), and what comes next in [PLAN.md](PLAN.md).

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
cosign verify ghcr.io/kodra-io/kodra-agent:0.3.8 \
  --certificate-identity-regexp '^https://github.com/kodra-io/kodra-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/kodra-io/charts/kodra-agent:0.3.8 \
  --certificate-identity-regexp '^https://github.com/kodra-io/kodra-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# The SBOM attached to the image, and the files on the GitHub release.
docker buildx imagetools inspect ghcr.io/kodra-io/kodra-agent:0.3.8 --format '{{ json .SBOM }}'
gh release download v0.3.8 --repo kodra-io/kodra-agent
sha256sum -c SHA256SUMS
```

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). For a review
before you run it, start with the [security review brief](docs/security/review-brief.md).
The agent's metrics, dashboard, alerts, traces, and audit chain are in
[docs/observability.md](docs/observability.md).

## License

[Apache-2.0](LICENSE)
