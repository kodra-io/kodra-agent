# Kodra Agent: Build Spec v0.1

Owner: Omar Al-Amad (Kodra.io)
Status: in implementation (M0). Decisions confirmed in section 14
Audience: Claude Code (implementation) and Omar (review)

---

## 1. What we are building

Kodra Agent is a self-hosted, customizable AI DevOps agent.

A user opens the Kodra Agent configurator (a static web page), clicks "Create your agent", and picks the capabilities they want: model provider, Git, Docker, Kubernetes, CI/CD, monitoring, cloud provider, and chat. They download a small bundle and run it in their own environment. On first run, a setup wizard asks only for the secrets the enabled features need and stores them in the user's environment (env vars, a local `.env` file, or a Kubernetes Secret). Kodra never sees, receives, or stores any secret.

Once running, the agent takes code from repo to running service (build, containerize, package, ship) and then stays on duty: it watches Prometheus and Grafana, investigates alerts, and talks to the team in Slack, asking for approval before it changes anything.

It is free to use: the core is open source and users bring their own model key, so a free user costs Kodra nothing to serve.

---

## 2. Principles (non-negotiable)

1. **Keys stay home.** The configurator has no secret input fields and makes no network requests beyond its own static assets. The agent keeps secrets only in the user's environment. There is no Kodra backend in the MVP.
2. **One agent, many configs.** One versioned agent image. Behavior is determined entirely by `kodra-agent.yaml`. Never generate per-customer code.
3. **Every capability is a connector.** Each connector is a declarative manifest plus an MCP server. Disabled connectors are never started.
4. **Safe by default.** Read-only unless the user grants write access. Every write needs human approval. Destructive actions are blocked by default. Any tool without a risk classification is blocked.
5. **Auditable.** Every model call, tool call, approval, and result is written to an append-only audit log inside the user's environment, with secrets redacted.
6. **No telemetry by default.** Opt-in only. Telemetry never contains secrets, prompts, or tool output.
7. **Honest copy.** No fabricated stats, logos, or testimonials anywhere in the UI or docs.

---

## 3. User flow

1. Open the configurator and click "Create your agent".
2. Name the agent and choose a deployment target: Docker Compose or Kubernetes (Helm).
3. Choose a model provider and enter a model id.
4. Toggle connectors on or off. For each enabled connector, choose an access level: `read-only` or `read-write-approved`.
5. Review a plain-language permissions summary and the list of secrets the wizard will ask for (names only, never values).
6. Download `kodra-agent-<name>.zip`, generated entirely in the browser.
7. In their own environment, unzip and run the wizard:
   - Compose: `docker compose run --rm kodra-agent init`
   - Kubernetes: `kodra-agent init --target kubernetes`
8. The wizard prompts for each required secret with masked input, validates each one with a cheap read call, and stores it locally.
9. Start the agent (`docker compose up -d` or `helm install`). It posts a hello message in Slack (or the CLI) summarizing what it can and cannot do.

---

## 4. Architecture

TypeScript end to end, so the config schema is shared by the configurator and the agent and validated identically on both sides.

```
kodra-agent/
├─ apps/
│  ├─ configurator/      React 19 + Vite + Tailwind, static site, no backend
│  └─ agent/             Node.js runtime + CLI (init, doctor, run, chat, ship)
├─ packages/
│  ├─ schema/            zod schema for kodra-agent.yaml, types, JSON Schema export, secret-ref parser
│  ├─ connectors/        one manifest per connector, plus the registry and dependency rules
│  └─ templates/         bundle templates and ship-flow templates (Dockerfile, CI, Helm)
├─ charts/kodra-agent/   Helm chart for the agent
├─ docker/               agent Dockerfile
├─ docs/                 connector docs, security model
└─ .github/workflows/    CI and release
```

Tooling: pnpm workspaces, Node.js current LTS, TypeScript strict mode, Vitest, Playwright (configurator end-to-end), ESLint and Prettier, gitleaks in CI.

---

## 5. The config file: `kodra-agent.yaml`

The single source of truth for what an agent can do. Validated by `packages/schema` in both the configurator and the agent.

```yaml
apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: payments-team-agent
spec:
  target: compose                  # compose | kubernetes
  model:
    provider: anthropic            # anthropic | openai | azure-openai | bedrock | ollama
    name: "<model-id>"
    apiKey: ${env:ANTHROPIC_API_KEY}
  connectors:
    github:
      enabled: true
      access: read-write-approved  # read-only | read-write-approved
      config:
        repos: ["acme/payments-api"]
      secrets:
        token: ${env:GITHUB_TOKEN}
    kubernetes:
      enabled: true
      access: read-only
      config:
        namespaces: ["payments"]
      secrets:
        kubeconfig: ${file:/secrets/kubeconfig}
    prometheus:
      enabled: true
      access: read-only
      config:
        url: http://prometheus.monitoring:9090
        pollIntervalSeconds: 60
    slack:
      enabled: true
      config:
        channel: "#payments-ops"
      secrets:
        botToken: ${env:SLACK_BOT_TOKEN}
        appToken: ${env:SLACK_APP_TOKEN}
  policy:
    approvals:
      required: true
      approvers: ["@omar"]
      expiresAfterMinutes: 15
    destructiveActions: deny
  audit:
    path: /var/lib/kodra-agent/audit.jsonl
  telemetry:
    enabled: false
```

Rules:
- Secret values never appear in this file, only references. MVP supports `${env:NAME}` and `${file:/path}`. Later: `${vault:...}`, `${aws-sm:...}`, `${azure-kv:...}`.
- The schema is strict: unknown keys are rejected with a readable error.
- `apiVersion` is versioned. The agent refuses an unknown major version and says why.
- Model ids are free text with suggestions in the configurator. Do not hardcode a model list: names change too often.
- Ollama takes a `baseUrl` instead of an API key, which makes air-gapped setups possible.
- Model fields per provider (confirmed for M1):

  | Provider | Fields besides `provider` and `name` |
  |---|---|
  | `anthropic`, `openai` | `apiKey`, optional `baseUrl` |
  | `azure-openai` | `apiKey`, `endpoint`, `deployment` |
  | `bedrock` | `region`. Credentials come from the standard AWS sources (env, IRSA, profile) |
  | `ollama` | `baseUrl` |
- `policy.approvals.required` can only be `true` in `v1alpha1`. `destructiveActions` is `deny` (default) or `require-approval`. Approvers are Slack handles (`@omar`) or Slack user ids (`U0123ABCD`).
- `policy`, `audit`, `telemetry`, and `monitoring` (`maxConcurrent` 2, `maxPerHour` 10, `cooldownMinutes` 60) have defaults. Each connector's `config` and `secrets` are validated against its manifest.
- The JSON Schema for editors is committed at `schema/kodra-agent.schema.json` (regenerate with `pnpm schema:export`). Examples live in `examples/`.

---

## 6. Connector model

Each connector is a typed, validated manifest at `packages/connectors/<id>/manifest.ts` with:

- `id`, `displayName`, `category`: `model | source | build | deploy | cicd | monitoring | cloud | chat`
- `status`: `available | coming-soon`
- `requires`: dependencies on other connectors or categories (for example, `cicd` requires a `source` connector)
- `configFields`: non-secret settings with validation (URLs, namespaces, repos)
- `secrets`: for each one: env var name, description, how to create it, minimum scopes, and a validation probe (a cheap read call used by `init` and `doctor`)
- `tools`: every tool the connector exposes, each classified `read | write | destructive`
- `runtime`: how the agent starts it. An MCP server (stdio subprocess or pinned container image) or a built-in module for chat surfaces
- `permissionsSummary`: plain-language lines for the review screen, in English and Arabic

Adding a connector means adding a manifest (and a server, only if none exists). The configurator renders entirely from manifests: no connector-specific UI code.

### Reusing existing MCP servers

Prefer existing, actively maintained, permissively licensed MCP servers, pinned by version or digest and wrapped with the agent's risk policy. Candidates to evaluate include GitHub's official MCP server, Grafana's `mcp-grafana`, the AWS Labs MCP servers, and community Kubernetes MCP servers. Before adopting any server:

1. Verify its license, maintenance activity, and the exact tools it exposes.
2. Classify every tool's risk in the manifest. Unclassified tools are blocked.
3. Document the decision in `docs/connectors/<id>.md`.

Write a custom server only where nothing suitable exists.

### MVP connector catalog

| Category | Connector | MVP | Default access | Notes |
|---|---|---|---|---|
| Model | Anthropic, OpenAI, Azure OpenAI, AWS Bedrock, Ollama | Yes | n/a | Ollama enables fully local models |
| Source | GitHub | Yes | read-only | Writes are limited to branches and PRs. Never push to the default branch |
| Source | GitLab | Yes | read-only | Same rules as GitHub |
| Build | Docker | Yes | read-only | Image builds need a Docker socket or BuildKit, see section 9 |
| Deploy | Kubernetes (EKS, AKS, GKE, on-prem) | Yes | read-only | Namespace-scoped RBAC is generated for the user |
| CI/CD | GitHub Actions, GitLab CI | Yes | read-only | Read runs and logs. Writes = propose pipeline files via PR |
| Monitoring | Prometheus, Grafana (incl. Loki via Grafana) | Yes | read-only | |
| Cloud | AWS | Yes | read-only | EKS and CloudWatch reads (ECR waits for a narrower MCP server; see docs/connectors/aws.md) |
| Cloud | Azure, GCP | Coming soon | | |
| Chat | Slack | Yes | n/a | Socket Mode, so no inbound public endpoint is needed |
| Chat | Microsoft Teams | Coming soon | | Needs a bot endpoint, phase 2 |
| CI/CD | Jenkins, Azure DevOps, Bitbucket | Coming soon | | |

---

## 7. Configurator (`apps/configurator`)

A static single-page app, deployable to S3 and CloudFront.

### Steps

1. **Start:** agent name, deployment target.
2. **Model:** provider cards, model id input (free text with suggestions), `baseUrl` for Ollama.
3. **Connectors:** grouped by category. Each has a toggle, an access-level selector, and inline "what it can do" and "what it needs" (secret names and minimum scopes).
   - Dependencies: enabling CI/CD suggests a source connector. Missing dependencies show an inline warning and block the download until resolved.
   - Coming-soon connectors are visible but disabled.
4. **Review:** plain-language permissions summary, the list of secrets the wizard will ask for, and the approval policy (approvers, destructive actions denied).
5. **Download:** zip generated in the browser (JSZip), plus copy-to-clipboard quickstart commands.

### Behavior

- A live preview panel shows the generated `kodra-agent.yaml`, `.env.example`, and `docker-compose.yml` or `values.yaml`. Desktop: side panel. Mobile: below the steps.
- Configuration state is stored in the URL hash, so a setup can be shared as a link. It never contains secrets by design.
- English and Arabic with full RTL support and a language toggle. All copy lives in locale files. Omar reviews the Arabic copy.
- WCAG 2.1 AA: keyboard navigable, visible focus states, sufficient contrast.
- Content Security Policy set. Fonts are self-hosted. No third-party requests of any kind.
- The page shows this privacy line, and it must stay true: "This page never asks for your keys. Your choices stay in your browser."

### Brand tokens

| Token | Value |
|---|---|
| primary | `#3250A0` |
| primary-deep | `#26407F` |
| primary-tint | `#EEF1F8` |
| text | `#172554` |
| text-secondary | `#6B7785` |
| background | `#FAFBFC` |
| border | `#E4E8EE` |

One accent color only. Headings in Arial. Body in a system font stack. For Arabic, a self-hosted font with good Arabic coverage. Copy rules: plain language, no em dashes, no fabricated stats or testimonials.

### Bundle contents

```
kodra-agent-<name>/
├─ kodra-agent.yaml
├─ .env.example          variable names only, empty values, a comment on where to get each one
├─ .gitignore            includes .env
├─ docker-compose.yml    compose target only
├─ values.yaml           kubernetes target only
├─ rbac.yaml             kubernetes target only: namespace-scoped, least privilege
└─ README.md             3-step quickstart, permissions summary, how to uninstall
```

---

## 8. Agent runtime (`apps/agent`)

### CLI commands

- `kodra-agent init`: reads `kodra-agent.yaml`, works out the required secrets from the enabled connectors, prompts with masked input, runs each connector's validation probe, and stores the values.
  - Compose: writes `.env` with file mode `0600`.
  - Kubernetes: creates a Secret, or prints the manifest with `--dry-run`. The dry-run manifest has placeholders, never values (golden rule 1), plus the equivalent `kubectl create secret` command. The bundle runs `init` from the agent image, so no local CLI is needed.
  - File secrets on compose (like a kubeconfig) are copied into `./secrets/` with mode `0600`; the bundle mounts that folder read-only at `/secrets`.
  - Never echoes a value. `--non-interactive` reads from the existing environment (for CI).
- `kodra-agent doctor`: validates the config, resolves secret references without printing them, checks connectivity and permissions per connector, and prints a pass/fail table with fix hints (`--json` for machine output). It also checks that the audit log is writable and that `.env` is owner-only. Checks are the read-only probes named in each manifest: one per secret, plus an optional `healthProbe` for connectors without secrets. AWS and Bedrock checks arrive with the AWS SDK in M4.
- `kodra-agent run`: starts the service. Loads the config, starts enabled connectors only, starts the chat surfaces and the monitoring loop, and serves `/healthz` and `/readyz`.
- `kodra-agent chat`: local terminal chat, useful without Slack.
- `kodra-agent ship <repo>`: the build-to-ship flow in section 9.

### Core modules

- **config:** load, validate, resolve secret references.
- **secrets:** resolvers for `env` and `file` (vault and cloud secret managers later). Values live in memory only and are registered with the redactor.
- **redactor:** masks every known secret value, plus common token patterns, in logs, the audit log, and anything sent to the model.
- **llm:** one interface over Anthropic, OpenAI, Azure OpenAI, Bedrock, and Ollama. The Vercel AI SDK is the suggested abstraction. Verify current package names and APIs in its docs before implementing.
- **connector host:** starts MCP servers for enabled connectors (stdio subprocess in the MVP), lists their tools, applies each manifest's risk classification, and exposes only allowed tools to the agent loop. A tool missing from the manifest is treated as destructive and blocked.
- **policy engine:** for every tool call:
  - `read`: runs.
  - `write`: needs approval when access is `read-write-approved`, otherwise blocked.
  - `destructive`: blocked unless policy allows it and it is approved.
  - Approval requests show the exact action and arguments (secrets redacted), who asked, and why. Approvals expire.
- **agent loop:** tool-calling loop with a step limit, a timeout, and a token budget per task. The system prompt carries the guardrails. Tool output is wrapped and labeled as untrusted data, and instructions found inside it are never followed.
- **audit:** append-only JSONL, one record per event: task start, model call metadata, tool call, approval request, approval decision, result, error. Each record has a timestamp, actor, connector, tool, risk level, and decision. Never secret values. Rotated by size.
- **chat surfaces:** Slack via Bolt in Socket Mode (mentions and DMs to talk, interactive buttons for approvals), and the CLI chat.
- **monitoring loop:** polls Prometheus or Alertmanager for firing alerts at the configured interval. A new alert opens a read-only investigation and posts a summary, the evidence, and a suggested fix to Slack. Repeated alerts are deduplicated.

---

## 9. The ship flow (A to Z)

Input: a repo and a branch.

1. **Detect:** language, framework, build tool, ports, and any existing Dockerfile, CI file, or Helm chart. MVP stacks: Spring Boot (Maven and Gradle), Node.js, Python, Go.
2. **Generate** what is missing:
   - Dockerfile: multi-stage, non-root, pinned base image.
   - CI pipeline: GitHub Actions or GitLab CI, matching the source connector.
   - Helm chart: deployment, service, probes, resource requests and limits.
3. **Verify:** build the image and run a smoke test (container starts, listens on its port, health check passes). On failure, read the error, fix, and retry up to a configured limit, then report exactly what changed.
4. **Package:** `helm lint` and a template render check.
5. **Ship:** open a PR containing all artifacts, with a description explaining each choice. A human merges. Deployment happens through the user's own CI after merge.
6. **Watch:** after deploy, check rollout status and key metrics, and report in Slack.

Templates first, model second: known stacks use tested templates from `packages/templates`. The model fills gaps and fixes errors. This is what makes output reliable.

Build environment: the compose target may mount the Docker socket only when the user enables the Docker connector with build permission, and the bundle README must explain that risk plainly. The Kubernetes target never mounts the Docker socket: builds go through the user's CI (rootless BuildKit jobs are phase 2).

---

## 10. Packaging and release

- **Agent image:** multi-stage build, minimal base image, non-root user, read-only root filesystem where possible, health check.
- **MCP servers:** pinned by version or digest in their manifests.
- **Helm chart:** ServiceAccount plus a namespace-scoped Role and RoleBinding generated from the enabled connectors' access levels. Secrets are referenced, never templated with values. Restricted pod security. Resource requests and limits.
- **Release workflow (GitHub Actions):** lint, typecheck, test, build, SBOM, sign images with cosign (keyless), push images and the OCI chart to the registry, attach checksums to the GitHub release.
- **Configurator:** builds to static files. Deployment is done by Omar and is out of scope here.

---

## 11. Security checklist

- [ ] Configurator has no secret inputs and makes no third-party requests. CSP set. Fonts self-hosted.
- [ ] `.env` written with mode `0600`. The bundle's `.gitignore` covers it. README warns never to commit it.
- [ ] Tests prove that a secret value never appears in logs, the audit log, or model payloads.
- [ ] Tool output is treated as untrusted. Instructions inside it are never executed. Approvals always show the concrete action.
- [ ] Unclassified MCP tools are blocked.
- [ ] Never push to a default branch. PRs only.
- [ ] Kubernetes RBAC is least privilege and namespace-scoped.
- [ ] Dependencies pinned. Automated dependency updates enabled. gitleaks and a dependency audit run in CI.
- [ ] No telemetry unless enabled. If enabled, the payload is documented and contains no secrets, prompts, or tool output.

---

## 12. Milestones

Every milestone ends with: all tests green, a short summary of what was built, how to try it, and open questions. Stop after each milestone for review.

**M0: Scaffold**
Monorepo, tooling, CI (lint, typecheck, test, gitleaks), LICENSE, README skeleton, CLAUDE.md commands section filled in.
Done when `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass locally and in CI.

**M1: Schema and connector manifests**
zod schema for `kodra-agent.yaml`, JSON Schema export, secret-reference parser, a manifest for every connector in section 6 (coming-soon ones included and marked), dependency rules.
Done when example configs validate, invalid ones fail with readable errors, and unit tests cover dependency rules and secret-reference parsing.

**M2: Configurator (the first demo)**
All steps in section 7, live preview, browser-side zip, English and Arabic with RTL, brand tokens, shareable URL state.
Done when Playwright tests cover: building a config, dependency warnings, switching to Arabic (RTL), and downloading the zip and validating its `kodra-agent.yaml` against the schema.

**M3: Agent core**
Config loading, `env` and `file` secret resolvers, redactor, audit log, `init` (compose and kubernetes), `doctor`.
Done when `init` writes a `0600` `.env` using masked prompts, `doctor` reports per-connector status, and redaction tests pass.

**M4: Models, connectors, and policy**
Provider abstraction (all five providers), MCP connector host, policy engine with approvals, CLI chat. Connectors: GitHub, GitLab, Kubernetes, Prometheus and Grafana, AWS (read-only).
Done when, against a local kind cluster, `kodra-agent chat` explains why a crashlooping pod is failing using read-only tools, a write action asks for approval in the CLI, and blocked actions are recorded in the audit log.

**M5: Slack and the monitoring loop**
Bolt in Socket Mode, approval buttons, alert polling with deduplication.
Done when a firing test alert produces an investigation summary in a Slack test channel, and an approval click executes the approved action and is audited.

**M6: Ship flow**
Stack detection, templates for Spring Boot, Node.js, Python, and Go, image build and smoke test, PR creation.
Done when, on four sample repos (one per stack), the flow produces a successful image build and opens a PR whose Helm chart passes `helm lint`.

**M7: Packaging and release**
Agent Dockerfile, compose template, Helm chart with generated RBAC, release workflow with SBOM and cosign signing.
Done when someone on a fresh machine can go from a downloaded bundle to a running agent by following the bundle README alone.

**M8: Web console (after the MVP)**
M8a: a read-only console served by `kodra-agent run`: overview, connectors with their tools and limits, activity from the audit log, investigations, usage with an estimated cost, and approvals. Local access only (localhost on Compose, port-forward on Kubernetes), signed in with a token that `init` creates.
M8b: chat and approvals in the browser. Console approvers (`console:<name>`) sign in with their own token; approval requests go to the console and Slack, and the first decision wins.
Done (M8a) when the image serves the console, sign-in is required for every API route, and the pages show a real agent's data. Done (M8b) when a question asked in the console shows its tool calls live, a console approver approves or denies a change there, and the decision is audited with their name.


**M9: From diagnosis to fix (after the MVP)**
M9a: proposed changes. The model proposes several tool calls as one change; the agent checks every step with the policy, shows one preview (a diff for each file edit), asks once, runs exactly the approved steps in order, and stops if a file changed after the preview. See `docs/fixes.md`.
M9b: fixes after an investigation (rollout restart and undo, declared as built-in Kubernetes tools), proposed for approval, then checked.
M9c: deploy with Helm after ship, check the rollout, and offer a rollback for approval.
Done (M9a) when a chat request for a file edit in a configured repo produces one approval with a diff, and approving it creates the branch, writes the file, and opens the pull request, all audited.
---

## 13. Out of scope for the MVP

- A hosted SaaS version, user accounts, billing, license keys
- Paid tier features: SSO, multi-cluster, audit export integrations, roles for the agent's users (planned later, kept in a separate `ee/` directory under a commercial license)
- Teams, Azure, GCP, Jenkins, Azure DevOps, and Bitbucket connectors (shown as coming soon)
- Vault, AWS Secrets Manager, and Azure Key Vault secret references
- Autonomous remediation without approval
- User accounts or single sign-on for the web console (it signs in with tokens)

---

## 14. Decisions (confirmed by Omar, 2026-10-02)

| # | Decision | Confirmed | Why |
|---|---|---|---|
| 1 | Language | TypeScript monorepo | One schema shared by configurator and agent |
| 2 | Repo host | Public GitHub repo `kodra-io/kodra-agent` | Where open-source users discover and star projects |
| 3 | License | Apache-2.0 for the core | Permissive and enterprise-friendly, with patent grant |
| 4 | Image and chart registry | GitHub Container Registry | Free for public images, sits next to the repo |
| 5 | Configurator location | `build.kodra.io/agent` | A path on the Kodra Build site, built with Vite `base: '/agent/'` and deployed to the Build bucket under `agent/`. Needs a CloudFront Function rewriting `/agent/` to `/agent/index.html`, a Build-site S3 sync that leaves `agent/` alone, and its own CSP header for the path |
| 6 | Configurator analytics | None at launch | Keeps the privacy line fully true. If added later: page views and a download count only, never the selected configuration |
| 7 | Product name | Kodra AI Agent | Display name. The technical name stays `kodra-agent` (CLI, config file, image, chart) |
| 8 | Branching | Feature branches with PRs into `main`, releases from tags | Standard open-source flow. No `develop` branch |
