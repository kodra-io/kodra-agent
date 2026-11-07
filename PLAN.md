# Kodra AI Agent: Launch Plan

Owner: Omar Al-Amad. Written 24 October 2026, at `335e960` (v0.3.10).
This plan replaces the long plan, which moves to `docs/roadmap.md`, where it is parked.

## The goal

Get the agent in front of real users and learn what they actually use. Nothing else happens until then.

## The gate

Until the gate opens:

- **No** new features, connectors, settings, or hardening.
- **Allowed:** the steps in this file, bug fixes, security fixes to existing features, dependency updates, docs, and tests.
- **Parked:** open branches stay unmerged. None are open now: M30a (#80) and M30b (#81) were merged on 24 October 2026, before this plan was adopted; see `docs/roadmap.md`.
- **New ideas** go to `docs/roadmap.md` under "Ideas". Mention each one in your summary, but don't build it.

The gate opens when two things are true: the configurator is live, and three outside teams have run the agent for two weeks. Then Omar picks the next item from `docs/roadmap.md` and adds it to this file. Work on it starts only after that.

---

## Steps

### L0: Reset

- Move the old plan to `docs/roadmap.md` and add this line at its top: "Parked until the launch gate in PLAN.md opens. Release numbers in this file are out of date."
- **Trim `CLAUDE.md` to about half its current size.**
  - Keep: what the product is, the golden rules, how to work (pointing to this file and the gate), commands, the repo map, and conventions.
  - Move the subsystem notes into `docs/dev/<subsystem>.md`, one file per subsystem, and list them in `CLAUDE.md` with one line each.
- Record `feature/console-onboard-m30a` in `docs/roadmap.md` as parked.

Done when: every note moved out of `CLAUDE.md` has a home in `docs/dev/`, both plan files are in place, and all tests pass.

### L1: Launch narrower

- **Add a `preview` connector status.** It means the connector works but is less tested and may change.
  - Preview connectors show a "Preview" badge in the configurator and the console.
  - They are off by default and grouped under "More connectors".
- **Stable:** Kubernetes, Prometheus, Grafana, GitHub, GitHub Actions, GitLab, GitLab CI, Slack, AWS, and the five model providers.
- **Preview:** Jenkins, Databases, and Docker build access, which makes `ship` preview too.
- **README:**
  - Add a short "What's stable" table.
  - Rewrite the "What it does" paragraph so it leads with read-only investigation, not the full feature list.

Done when: preview connectors show the badge and are off by default, a starter profile in the configurator never shows them unless the user opens "More connectors", and the tests cover both.

### L2: Close the red flags

- **No default credentials.**
  - Remove admin/admin.
  - `init` either asks for the console admin password or generates a random one and shows it once. On Kubernetes, the hash goes into the Secret.
  - If no password has been set, the console refuses to start.
- **F9.** Narrow the Kubernetes write role to `deployments/scale`. The kind test must prove that the scale tool still works with the narrowed role. If it doesn't, mark Kubernetes write access as preview instead: partners then run read-only until the guardrails in the roadmap (M9b) are built.
- **Docs.** Update `docs/known-limitations.md` and the findings table in `docs/roadmap.md`.

Done when:

- A test proves no code path accepts a default password.
- The kind test scales a deployment with the narrowed role, or Kubernetes write access is marked preview.
- The docs are updated.

### L3: Proof

One set of failure scenarios serves both the demo and the evaluations.

- **Scenarios.** Ten scenarios on kind in `evals/scenarios/<id>/`. Each holds the manifests, the trigger (an alert or a question), the expected root-cause facts, and the actions that must not be proposed. The ten:
  1. crashloop (the existing one)
  2. missing environment variable
  3. OOMKilled
  4. bad image tag
  5. failing readiness probe
  6. Service selector with no endpoints
  7. PVC Pending
  8. missing ConfigMap key
  9. unschedulable pod
  10. a release that returns 500s
- **`pnpm eval --provider <p> --model <id>`** runs deterministic checks. It writes a JSON result and a Markdown report covering, for each scenario: right root cause or not, steps taken, tokens, and cost.
- **`kodra-agent demo`** runs three of the scenarios on a throwaway kind cluster with the user's own model key, prints the findings, and cleans up with `--cleanup`. It runs as a one-shot service, never inside the always-on one.
- **Real numbers only.** Any figure in the README comes from a real run, with the date and the model id.

Done when:

- The suite runs locally against Ollama and against one hosted model.
- The package test runs the demo end to end with a mock model.
- The first report is committed.

### L4: Publish

- **Claude Code** gets the configurator ready to deploy:
  - the build
  - the steps in `docs/configurator-deploy.md`
  - the CSP header
  - a post-deploy check: the page loads, makes no outside requests, and downloads a valid bundle
- **Omar** deploys it to `build.kodra.io/agent`.
- **Hallway test.** Someone who has never seen the project goes from the configurator to a first answer, using only the README. Fix every place they get stuck.
- **Release v0.4.0,** the public launch.

Done when the page is live, the post-deploy check passes, and the hallway test finishes without help.

### L5: Partner zero, Kodra.io

This step can start as soon as L2 is done.

- **Omar** runs the agent read-only on Kodra.io's EKS cluster for two weeks, with Slack and the daily digest on.
- **Notes go in a private repo** (for example `kodra-io/agent-field-notes`), because this repo is public: what the agent got right, what it got wrong, what was missing, and what was noise.
- **Claude Code** fixes the bugs this finds (the gate allows bug fixes) and turns every wrong diagnosis into an eval scenario, without any private details.

Done when there are two weeks of notes and every wrong diagnosis is in the eval suite.

### L6: Design partners

- **Three to five outside teams.** Their notes also go in the private repo. Only anonymized lessons and eval scenarios come back here.
- **Read-only first.** Write access only after F9 is closed and the team asks for it.
- **After two weeks,** record what each team wants next.

Done when three outside teams have used the agent for two weeks. The gate then opens.

### Added before the gate opens

Omar approved these two steps on 29 October 2026, ahead of the gate, after onboarding a test
service showed what was missing. Bug fixes from the same review shipped first (#90).

#### B1: The pipeline that fits

- **Standalone or shared.** A repo with CI keeps it. Otherwise the connector's `pipeline`
  (`auto`, `shared`, `standalone`) and `pipelineTemplate` decide; on `auto`, the agent reads
  the other configured repos' CI and calls the shared workflow or template most of them use.
- **Fills in the caller** from the detection and from values the other repos agree on. The
  rest is listed in the pull request. Credentials are never copied.
- **Reads the template** when its repo is configured or named: its inputs and required secrets.

Done when ship and onboard write a working caller for a GitHub reusable workflow and a GitLab
`include: project`, with tests on real git repos.

#### B2: Test in a sandbox, then destroy

- **One `sandbox` namespace** (configurable, not named after Kodra) where the agent may create
  and delete workloads, and nothing outside it. Helm keeps its records in ConfigMaps, so the
  agent never needs Secrets.
- **One approval** deploys the pull request's `pr-<sha>` image with its chart as release
  `kt-<id>`, smoke-tests it, reports, and uninstalls it (or keeps it up to 24 hours).
- **Destroys only its own releases:** recorded and labeled by the agent. Expired ones are swept
  on startup and every 5 minutes while `run` is up.
- **Test settings:** placeholders for each secret, overridden by an optional
  `<app>-sandbox-env` Secret the team creates and the agent never reads.

Done when a kind test deploys, checks, and destroys a release, and shows the agent cannot touch
anything outside the sandbox or a release it did not create.

#### B3: Configurator clean-up

- **Profiles named for what they do:** "Approve your own changes", "Peer review in
  production", and "Two approvers in production". The `kodra-agent.yaml` values stay
  `starter`, `team`, and `strict`.
- **Ollama address examples** for the same machine (`host.docker.internal`), Compose, and
  Kubernetes; the Compose bundle maps `host.docker.internal` on Linux.
- **Kubernetes works with any cluster:** it takes a kubeconfig and nothing else. The AWS keys
  are gone; an EKS kubeconfig uses a service account token, or the agent's own AWS variables.
- **Docker, Jenkins, and Databases** are regular connectors, out of "More connectors".

Done when the configurator e2e tests cover each of these.

#### B4: The official MCP server for each connector

- **AWS: off for now.** Cloud providers are expected to become a licensed, paid add-on, so AWS
  is listed as coming soon, like Azure and Google Cloud (Omar, 31 October 2026). The manifest
  stays in the code, unregistered. `awslabs.aws-api-mcp-server` turned out to be superseded by
  AWS's managed AWS MCP Server; that choice waits until AWS comes back.
- **Cloud model providers: off for now.** Azure OpenAI and AWS Bedrock are refused in
  `spec.model` and `spec.models` with a "coming soon" message, and left out of the configurator
  and console (Omar, 31 October 2026). Their code stays, parked; Anthropic, OpenAI, and Ollama
  remain.
- **Remote MCP servers:** an HTTP runtime with the token as a header, through the proxy and CA
  settings.
- **GitLab:** GitLab's built-in MCP server (19.5 or newer) by default, for GitLab and GitLab
  CI; `server: community` keeps `@zereight/mcp-gitlab` for older GitLab (Omar, 31 October 2026).
- **Jenkins:** the Jenkins `mcp-server` plugin by default; `server: community` keeps
  `mcp-jenkins` for a Jenkins without the plugin (Omar, 31 October 2026).
- GitHub, Grafana, Kubernetes, and Prometheus already use the official or the only maintained
  server; Docker and Databases stay built in.

Done when every tool of each new server is classified, the real-server CI job runs them, and
the connector docs record each decision.

#### B5: Build with the connected CI tool

Omar approved this on 7 November 2026: the agent should build with whatever CI tool is
connected, not only the repo host's.

- **Pick the CI from the connectors:** `spec.ship.ci`, else the repo's own CI, else the CI
  connector that is turned on (Jenkins, GitHub Actions, GitLab CI), else the host's CI. The
  pull request says which and why. The console sets it under Settings, Connectors.
- **A Jenkinsfile** when Jenkins builds the repo: the same stages as the other pipelines, every
  step in Docker on the Jenkins agent, pushing to the connector's `registry` with its
  `registryCredentials` (an ID; the agent never reads the value).
- **Starting a build** of a listed job is a write with approval (it was destructive);
  rebuilding and answering pipeline inputs stay destructive. Jobs are never created.
- **After the pull request,** the agent finds the job for its branch, waits for Jenkins to
  build it or starts it after one approval, and reports the result with the end of the log.

Done when ship and onboard write a Jenkinsfile that Jenkins validates, and a test on a real
Jenkins finds, starts, and watches a build.

#### B6: From onboarding to a healthy deploy

Omar approved this on 7 November 2026: the agent should take a repo from onboarding to a
healthy deploy and report back, like a DevOps engineer, from the CLI, the console, and chat.
It takes the agreed parts of M23 (deploy stage), M25 (watch and fix in CI), and M9c (watch the
release) and keeps the rest parked.

- **A deploy stage** in the pipelines ship writes (`spec.ship.deploy`, off by default, set in
  the console under Settings, Connectors): after the tests, the image, and the chart check pass
  on the default branch, the pipeline deploys. Kubernetes: `helm upgrade --install` with the
  commit's image tag, waiting for the rollout and rolling back on failure. A VM: a script over
  SSH with a pinned host key that replaces the container, checks its health, and puts the
  previous image back on failure. `manual` uses the CI system's own gate (a Jenkins input
  step, GitHub environment reviewers, a manual GitLab job); production environments must use
  it. The pipeline holds the credentials in the CI system, by name; the agent never does. The
  PR includes a namespaced ServiceAccount and Role for the Kubernetes deployer.
- **Watch the pull request's CI** for every CI tool (Jenkins, GitHub Actions, GitLab CI). When
  it fails, the model reads the end of the log (untrusted) and either fixes a file ship added
  (up to `--max-fixes` commits, on that branch only) or says the cause is in the application,
  which it never changes. The PR's one approval covers the branch, the PR, starting its Jenkins
  build, and those fix commits, and says so.
- **Then** the sandbox test (B2, its own approval) and a report: ready to merge, or what a
  person must do, posted to the terminal, the console, and Slack.
- **After the merge,** `kodra-agent release <repo>` (or the console, or chat) watches the
  default branch's run, checks the deployment with the agent's read access (the Deployment's
  image and ready replicas, or the VM's health endpoint), investigates read-only when
  something fails, and reports. It never deploys or rolls back by itself.
- **Chat:** `kodra_onboard`, `kodra_sandbox_test`, `kodra_watch_release`, `kodra_job`, and
  `kodra_repos` start and read the same background jobs as the console's Repos page.
  Approvers only; every change inside still waits for an approval.

Still parked: scan, SBOM, and signing (M21); more registries and build engines (M22); GitOps
mode and OIDC federation for deploys (M23); Azure Pipelines (M24); more than one deploy target
per repo; Kubernetes fixes by the agent (M9b); judging releases by metrics (M9c).

Done when ship and onboard write a deploy stage that each CI system accepts (Jenkins validates
it on a real Jenkins), a failing CI run is fixed on the branch within the limit in a test, and
the demo repo goes from onboarding to a healthy deploy on kind with Jenkins.

#### B7: Claude Code as the model

Omar approved this on 7 November 2026: use the user's own Claude plan through Claude Code
instead of an API key. Anthropic allows an end user to sign in to the unmodified Claude Code
binary with their own subscription where a product runs it
([decision](docs/connectors/claude-code.md)).

- **`spec.model.provider: claude-code`**, with a model name (`sonnet`, `opus`, `haiku`, `fable`,
  or an id) and an optional `oauthToken` (`claude setup-token`). The configurator, the console's
  provider switch, and doctor render it from its manifest.
- **The unmodified binary, pinned** (2.1.311), downloaded on first start to the agent's volume
  and checked against its SHA-256. Not in the image (preinstalling needs Commercial Terms).
- **Sign-in with Anthropic's own flow:** `kodra-agent claude-code login` (and `status`,
  `logout`); the agent never reads the credentials.
- **Claude Code's own tools off** (`--tools ""`); the turn's tools are served to it over a local
  MCP server with a bearer token, so policy, approvals, redaction, and audit apply unchanged. A
  run that reports any other tool is stopped.

Still parked: Codex (it cannot turn off its shell tool, golden rule 1).

Done when a turn with Claude Code calls only the agent's tools through the policy engine (unit
tests with a fake binary, and a real signed-in run), a blocked tool stays blocked, no secret
reaches it, and doctor shows the sign-in.

---

## Status

| Step                                        | Status                                    | PR   |
| ------------------------------------------- | ----------------------------------------- | ---- |
| L0 Reset                                    | Done                                      | #82  |
| L1 Launch narrower                          | Done                                      | #87  |
| L2 Close the red flags                      | Done                                      | #84  |
| L3 Proof: scenarios, evals, and the demo    | Merged; the hosted run is still open      | #85  |
| L4 Publish and release v0.4.0               | In progress: deploy and hallway test next | #86  |
| L5 Partner zero: Kodra.io                   | Not started                               |      |
| L6 Design partners                          | Not started                               |      |
| B1 The pipeline that fits                   | Done                                      | #91  |
| B2 Test in a sandbox, then destroy          | Done                                      | #92  |
| B3 Configurator clean-up                    | Done                                      | #94  |
| B4 Official MCP servers                     | Done                                      | #101 |
| B5 Build with the connected CI tool         | In review                                 | #108 |
| B6 From onboarding to a healthy deploy      | In review                                 | #109 |
| B7 Claude Code as the model                 | In review                                 |      |
| Gate open: Omar picks the next roadmap item | Not started                               |      |

## Rules

- The golden rules in `CLAUDE.md` always apply.
- One step per branch and PR. Plan first and wait for Omar's approval. Stop at the end with tests green, a summary, and how to try it, then update the status table.
- Copy stays industry-neutral, and profiles set defaults, never limits.
- If it isn't in this file, it doesn't get built.
