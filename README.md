# Kodra AI Agent

A self-hosted, customizable AI DevOps agent by [Kodra.io](https://kodra.io).

You pick what the agent can do on a static web page, download a small bundle, and run it in
your own environment with your own model key. The agent builds, containerizes, packages, and
ships code, then watches your monitoring and works with your team in Slack. It asks for
approval before it changes anything.

> **Status: pre-alpha.** Nothing here is usable yet. The plan is in [SPEC.md](SPEC.md).

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
packages/schema       kodra-agent.yaml schema, types, secret-reference parser
packages/connectors   connector manifests, registry, dependency rules
packages/templates    bundle templates and ship-flow templates
schema                JSON Schema for kodra-agent.yaml, for editor validation
examples              example kodra-agent.yaml files
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

## License

[Apache-2.0](LICENSE)
