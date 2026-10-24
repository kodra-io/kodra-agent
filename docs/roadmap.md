Parked until the launch gate in PLAN.md opens. Release numbers in this file are out of date.

# Kodra AI Agent: Roadmap

The single plan for everything left to build. It replaces `PLAN-v0.2.md`.
Owner: Omar Al-Amad. Last updated 16 October 2026, at `a38c85d`.

`SPEC.md` describes the product. This file lists what is left to build, in order, and how we know each piece is done. Milestone ids never change, so references in code and docs stay valid.

---

## 1. Where we are

- **Released:** v0.2.0 (13 October 2026): the MVP, the web console, and proposed changes.
- **Done since:** M10 to M14 (#36 to #40): profiles, environments and approvals; change control; corporate networks; data protection and model routing; trust and observability.
- **Released:** v0.3.0 (16 October 2026): M10 to M14. The M15 demo was deferred until partners need it.
- **v0.3.1** (17 October 2026): console sign-in as `admin` with a password (`admin`/`admin` until changed). Tokens still work; user accounts come later.
- **v0.3.2** (17 October 2026): the console Dashboard (Kubernetes pods, deployments, and warnings; GitLab CI pipelines; GitHub Actions runs), `console:admin` as a default approver in the configurator, and the console model picker (models the key can use, with prices and this month on each, tested before saving).
- **v0.3.3** (17 October 2026): switching the model provider from the console (Anthropic, OpenAI, Azure OpenAI, Bedrock, Ollama), checked with the new key before anything is saved.
- **v0.3.4** (17 October 2026): the Jenkins connector (jobs, builds, logs, a Jobs dashboard card), and a model context check: a prompt that does not fit the model's window is refused with how to fix it, instead of answered from a cut-off prompt.
- **v0.3.5** (20 October 2026): an operations center on the console Overview: a greeting and posture, an attention queue, live systems, pipelines run today (passed, failed, running), and the databases you list in the Kubernetes connector (`namespace/name`), with pods ready and restarts.
- **v0.3.6** (21 October 2026): the Databases connector: MariaDB, MySQL, and PostgreSQL wherever they run (standalone, a cloud database, or Kubernetes), directly or through an SSH tunnel with a pinned host key. Fixed health checks only, shown on the Dashboard and counted on Overview. The MCP SDK moves to 1.32.1 for new advisories.
- **v0.3.7** (22 October 2026): the configurator lists databases (secrets named, never typed) and matches the product (console sign-in and pages, model suggestions); `init` checks each database on its own. The product is English only: Arabic and right-to-left support are removed.
- **v0.3.8** (23 October 2026): `kodra-agent onboard` reads a new repo (dependencies, the settings it reads, committed credentials by location only, gaps, questions for the team), then ships it with the setting names in the chart and an `ONBOARDING.md` in the PR. Scheduled checks post a daily digest to Slack and the console Overview: what is new, still broken, and fixed, from read-only rules with no model; `kodra-agent check` prints it. `ip-address` moves to 10.7.4 for a new advisory.
- **v0.3.9** (23 October 2026): every connector can be set up from the console: steps under each secret and setting with ready commands for Linux, macOS, and Windows, filled with your settings; kubeconfigs and SSH keys pasted or uploaded, checked, and saved as files; optional AWS keys for EKS kubeconfigs; and trusted CA certificates (like Amazon RDS's) uploaded in Settings, Network.
- **v0.3.10** (24 October 2026): guardrails. A kubeconfig with more access than the agent needs (cluster-admin, reading Secrets, changing deployments everywhere) is refused unless kept on purpose; at most 10 approved writes an hour and one change at a time per environment; scaling to zero or by more than half counts as destructive; each approved scale is watched until its pods are ready, with the rollback named if not; the daily digest flags expired, expiring, and old secrets; the Compose bundle caps memory, CPU, and processes and rotates logs. Dependencies move to patched versions for new advisories (undici, zod, vite, body-parser, fast-uri).
- **Next:** publish the configurator, test with our own setup, then design partners.
- **Who it's for:** many kinds of organizations, from solo developers and startups to large and regulated companies. The same product serves all of them, configured through profiles (`starter`, `team`, `strict`) that set defaults and never limits. See SPEC section 5 and `docs/approvals.md`.

### Focus: launch, then let users choose

M10 to M14 hardened the agent for large and regulated teams before anyone outside Kodra had used it. That work is done and tested, and it stays. From here:

- **No new hardening until a user asks for it.** M10 to M14 are complete; nothing is added to them before launch.
- **The shortest path to real users:** release, publish the configurator, and test with our own setup. The demo (M15) waits until partners need it.
- **After launch, design partners pick what comes next.** Everything in sections 6 to 8 is a candidate, not a schedule.
- **One user-visible thing per milestone.** Ideas found along the way go under open questions, not into the milestone.

---

## 2. Roadmap

| Release         | Theme                        | Milestones                    | Status                   |
| --------------- | ---------------------------- | ----------------------------- | ------------------------ |
| v0.2.0          | Console and proposed changes | M8, M9a                       | Released 13 October 2026 |
| v0.3.0 (launch) | Ready to try                 | M10 to M14                    | Released 16 October 2026 |
| After launch    | Chosen with design partners  | Candidates in sections 6 to 8 | Not scheduled            |

Why this order:

- Nobody outside Kodra has run the agent yet. Every milestone before real users is a guess about what they need.
- The candidates after launch are grouped as before (pipelines; diagnosis to fix; more teams) so they are ready to pick up. What partners try first, where they get stuck, and what they ask for decides the order. Section 5 says how to collect that.
- One exception stays fixed: the evaluation suite (M16) lands before any new Kubernetes writes (M9b), so quality is measured before the agent changes more things.

---

## 3. Findings (verified at 69032f2)

### Keep (do not regress)

- **Tool gating in code:**
  - Tools are allowlisted.
  - The Kubernetes server config denies Secrets, ServiceAccounts and RBAC kinds.
  - Namespace and repo guards check every call.
  - Generic create, update, exec and delete tools are classed destructive and never exposed.
- **MCP host isolation:**
  - Each server gets a private temp folder and a minimal environment holding only its own connector's secrets, plus the proxy and CA settings from M12.
  - Secrets go in env vars or 0600 files, never argv.
- **Tests that protect the rules:**
  - the real-servers test that fails on any unclassified tool
  - the canary test for leaked secrets
  - the proxy job (`pnpm test:proxy`)
  - the data-protection false-positive tests
  - the self-protection test
- **Approvals and writes:**
  - Approvals are checked by Slack user ID, with the M10 and M11 rules (self-approval, minimum approvers, freezes, change references).
  - Every file is re-read before a write, and nothing is ever written to a default branch.
- **Deployment safety:**
  - Settings restart on Compose by exiting with code 75.
  - The agent's permissions on its own resources are limited by `resourceNames`.
  - The chart keeps `replicas: 1` with the `Recreate` strategy.
- **MCP servers** are SHA-256 checked and installed into the image at build time.

### Findings

| #   | Finding                                                                                                                                                                                        | Fixed in | Status |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| F1  | No proxy or custom CA support; MCP servers never received proxy or CA variables                                                                                                                | M12      | Fixed  |
| F2  | Approvers could approve their own requests; one rule set covered every change                                                                                                                  | M10      | Fixed  |
| F3  | `@name` approvers were matched against editable display names                                                                                                                                  | M10      | Fixed  |
| F4  | Customer data in logs reached the model, the audit log, Slack and the console                                                                                                                  | M13      | Fixed  |
| F5  | The audit log has no hash chain, no way to detect edits, and no export path (`apps/agent/src/audit.ts`)                                                                                        | M14      | Fixed  |
| F6  | The agent has no metrics or traces of its own                                                                                                                                                  | M14      | Fixed  |
| F7  | With build access, the always-on service mounts the Docker socket (`packages/templates/src/bundle.ts`)                                                                                         | M14      | Fixed  |
| F8  | The chart had no NetworkPolicy                                                                                                                                                                 | M12      | Fixed  |
| F9  | `rbac.write` grants `patch` on Deployments, which can change the whole pod template, and every process in the pod can read the ServiceAccount token (`charts/kodra-agent/templates/rbac.yaml`) | M9b      | Open   |
| F10 | There is only one evaluation scenario, a crashloop (`apps/agent/scripts/kind-test.ts`)                                                                                                         | M16      | Open   |
| F11 | There is no `SECURITY.md`, threat model, data-flow page, or known-limitations page                                                                                                             | M14      | Fixed  |
| P1  | Pipelines never run tests: there is no test stage, and generated Dockerfiles skip tests (`-DskipTests`, `-x test`) (`packages/templates/src/ship/ci.ts`, `dockerfile.ts`)                      | M21      | Open   |
| P2  | The registry is fixed to GHCR or the GitLab project registry                                                                                                                                   | M22      | Open   |
| P3  | GitLab builds use Docker-in-Docker, which needs privileged runners                                                                                                                             | M22      | Open   |
| P4  | Only GitHub Actions and GitLab CI are supported                                                                                                                                                | M24      | Open   |
| P5  | There is no deploy stage, and the chart's image tag (`appVersion`) doesn't match the CI tag (the commit SHA)                                                                                   | M23      | Open   |
| P6  | `ship` runs only from the CLI, and its verification needs the Docker socket                                                                                                                    | M25      | Open   |

---

## 4. Pipelines design (for M20 to M25)

### Every stage is a toggle

- **One CI-neutral pipeline model:** an ordered list of stages, each with its inputs and settings.
  - Each CI system has one renderer that turns the model into that system's file.
  - Toggles add, remove or configure stages. Nothing else changes the pipeline.
- **A stage registry.** Each stage is declared once, the way connectors are declared in manifests. A declaration holds:
  - its id
  - a plain-language description
  - its settings and their validation
  - the CI systems and build engines that support it
  - what the team must add to their CI (secrets and variables, by name)
  - its default in each profile

  The configurator, the config schema, `ship`, the PR description and the bundle README all render from the registry. There is no stage-specific UI code.

- **Unsupported combinations are refused with a reason,** and the configurator disables them. Example: keyless signing on a CI system without OIDC tokens.

### The config

`spec.ship` already holds `baseImageMirrors` (M12). The pipeline settings extend it:

```yaml
spec:
  ship:
    baseImageMirrors: # from M12
      docker.io: harbor.example.com/dockerhub-proxy
    ci: github-actions # github-actions | gitlab-ci | jenkins | azure-pipelines
    verify: local # local (needs Docker) | ci (runs in your own pipeline)
    build:
      engine: docker # docker | buildkit-rootless | buildah
      platforms: [linux/amd64] # add linux/arm64 for multi-arch images
      cache: true
    registry:
      type: ecr # ghcr | gitlab | ecr | acr | gar | dockerhub | generic
      url: 123456789012.dkr.ecr.me-central-1.amazonaws.com/shop # image name defaults to the repo name
    stages:
      test: true # the project's own tests
      lint: true # the project's own lint command, when it has one
      scan:
        enabled: true
        failOn: critical # none | critical | high
      sbom: true
      sign: false
      deploy:
        enabled: true
        mode: helm # helm | gitops
        targets:
          - environment: staging # from spec.environments
            namespace: staging
            when: default-branch # default-branch | manual | tag
          - environment: production
            namespace: checkout
            when: manual # the CI system's own approval gate
    triggers: [cli, slack, console]
    repos: # optional overrides for one repo
      acme/legacy-billing:
        ci: jenkins
        registry:
          type: generic
          url: registry.internal.example/billing
```

Rules:

- **The agent never sets CI secrets or variables.** The PR description lists what the team must add, by name, with links to their CI system's docs.
- **Prefer OIDC federation over stored keys** for registries and clusters, wherever the CI system and the cloud support it. GitHub Actions and GitLab CI can federate to AWS, Azure and Google Cloud.
- **Deploy targets respect environment rules.**
  - If an environment's rules require approvals, its deploy target must use `when: manual`. Validation refuses `default-branch` for it.
  - A target's namespace must belong to its environment.
- **Generated files follow today's rules:**
  - actions and images pinned (by commit SHA or digest)
  - downloaded tools checksum-verified
  - least-privilege permissions for each job
  - no secrets in the YAML
- **Shipping happens through the team's own pipeline.** The agent writes the pipeline, the deploy stage (M23) deploys, and the agent watches the release and proposes rollbacks (M9c). The agent needs no deploy permissions of its own.

### Profile defaults for pipelines

| Toggle       | `starter`       | `team`                                                                       | `strict`                                        |
| ------------ | --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| Test         | On              | On                                                                           | On                                              |
| Lint         | On              | On                                                                           | On                                              |
| Image scan   | On, report only | On, fails on critical                                                        | On, fails on high and critical                  |
| SBOM         | Off             | On                                                                           | On                                              |
| Signing      | Off             | Off                                                                          | On, where keyless signing is available          |
| Cache        | On              | On                                                                           | On                                              |
| Multi-arch   | Off             | Off                                                                          | Off                                             |
| Build engine | Docker          | Docker                                                                       | Rootless BuildKit, where the runner allows it   |
| Verify       | Local           | Local                                                                        | In CI                                           |
| Deploy       | Off             | On once environments exist: staging on the default branch, production manual | On once environments exist: every target manual |

Profiles set defaults only. Every toggle can be changed in the configurator, the config or the console.

---

## 5. v0.3.0: launch

### M14: Trust and observability (done, #40)

Built: the audit hash chain with `kodra-agent audit verify`, a doctor row, the head hash on the console Overview, and `audit.stdout`; Prometheus metrics with an optional ServiceMonitor, PrometheusRule, and a Grafana dashboard; optional OpenTelemetry traces (off by default); the one-shot `kodra-builder` service, so the always-on service never mounts the Docker socket; and the security pack (`SECURITY.md`, threat model, data-flow page with a manifest fingerprint test, known limitations, review brief, and release verification in the README). Details: `docs/observability.md` and `docs/security/`.

Differences from the plan:

- `SECURITY.md` uses GitHub private vulnerability reporting (now on for the repo) instead of an email address (decision 1).
- Metrics are checked on kind by scraping `/metrics` through the chart's Service, and the alert rules with `promtool check rules` and a `promtool test rules` unit test, instead of installing Prometheus.
- The chain head in a daily digest waits for scheduled checks, which moved after launch.

### M15: Value on day one (the demo, deferred)

Deferred at launch: we test with our own setup first, and build the demo when partners without a cluster need it.

Trimmed to one thing: someone new sees the agent find real problems in a few minutes, with no setup of their own.

Build:

- **`kodra-agent demo`:** one command that needs only Docker and a model key (or a local model through Ollama). It:
  1. creates a throwaway kind cluster,
  2. deploys three broken workloads: a missing environment variable, an OOMKilled container, and a bad image tag,
  3. runs a read-only investigation for each one and prints the findings.

  `--cleanup` removes everything. It runs as a one-shot container with the Docker socket, never inside the always-on service. Start from what `pnpm test:kind --demo` already does (`apps/agent/scripts/kind-test.ts`) instead of writing it again. Keep it in the main image unless kind and kubectl make the image much larger.

- **README quickstart:** the demo first, then "make your own agent" in the configurator.

Not in M15 (moved to "Scheduled checks" at the end of section 6): scheduled checks and the daily digest, and the configurator's "Just trying it?" bundle.

Done when:

- The package test runs the demo end to end with a mock model, and `--cleanup` leaves no cluster or containers.
- Omar runs it on a clean machine, from the README alone, in under ten minutes.

### Launch

After v0.3.0:

1. Release v0.3.0, with the README status line updated (done, 16 October 2026).
2. Publish the configurator at `build.kodra.io/agent`.
3. Start with five to ten design partners. For each one, write down in `docs/partners/` (names left out unless they agree): what they tried first, where they got stuck, what they asked for, and whether they kept it running after a week.
4. Pick the next milestone from those notes, from the candidates below or something new.

---

## 6. Candidates after launch: pipelines

Not scheduled. Pick these up when design partners ask for them (section 5, Launch).

### M20: Pipeline model, toggles, and configurator

Build:

- **Pipeline model and stage registry** (section 4). Move today's GitHub Actions and GitLab CI templates onto the model with identical output.
- **Schema.** Extend `spec.ship` with the toggles, per-repo overrides, and validation, keeping `baseImageMirrors`. Profile defaults go through the effective-policy resolver from M10.
- **Configurator:** a "Pipeline" step, shown when a source connector is on. For each toggle it shows:
  - plain-language help
  - what the team must add to their CI
  - a live preview of the generated pipeline file for a sample app

  The shareable URL state includes the toggles.

- **Existing pipelines.** `ship` keeps them. Its PR description lists the enabled stages that the existing pipeline lacks.

Done when:

- Golden files show that the moved GitHub Actions and GitLab CI output matches today's byte for byte.
- Playwright shows the preview updating as toggles change.
- Invalid combinations show a reason.

### M21: Tests, lint, and supply chain

Build:

- **Test stage per stack.** Use the project's wrapper when it has one (`mvnw`, `gradlew`):
  - Maven: `test`
  - Gradle: `test`
  - Node.js: `npm test`, only when `package.json` defines it, after `npm ci`
  - Python: `pytest`, when tests exist
  - Go: `go test ./...`

  Tests run in a job using the stack's pinned toolchain image, before the image build. The image build runs only if the tests pass.

- **Lint stage.** Run the project's own lint command when it has one, plus `go vet` for Go. Never add a linter the project doesn't use.
- **Scan.** Scan the built image with the scanner from section 10 (proposed: Trivy).
  - `failOn` sets the threshold that fails the pipeline.
  - The report is saved as a CI artifact, and also as SARIF to GitHub code scanning where that is available.
- **SBOM.** Produce SPDX JSON, from BuildKit attestations where supported and from Syft otherwise. Attach it as a CI artifact or a registry attestation.
- **Signing.** Use cosign keyless with the CI system's OIDC token (GitHub Actions, GitLab CI). Sign the digest, not the tag, and put the verification command in the PR description.
- **Local verify** runs the test stage too, in a container, when the stage is on. Failures are reported, never "fixed": the model never edits application code or tests in `ship`.

Done when:

- Every sample app passes with all stages on, in a real GitHub Actions run and in GitLab CI.
- A sample with a known critical vulnerability fails the scan when `failOn` is `critical`.
- A failing unit test stops the pipeline before the image build.

### M22: Registries, build engines, and caching

Build:

- **Registries:** `ghcr`, `gitlab`, `ecr`, `acr`, `gar`, `dockerhub`, and `generic` (Harbor, Artifactory, Nexus, or any registry that uses a username and password).
  - Use OIDC federation where it is supported.
  - Otherwise, use credentials stored in the CI system, named in the PR.
- **Build engines:** `docker` (with buildx), `buildkit-rootless`, and `buildah`.
  - In profiles whose default is rootless, GitLab moves off Docker-in-Docker.
  - Check the current requirements for rootless BuildKit on GitLab and Kubernetes runners.
- **Multi-arch builds** (`platforms`), plus dependency and layer caching for each CI system.
- **Tags:** the commit SHA by default, and semver tags on git tags. `baseImageMirrors` still applies to base images.

Done when:

- A test matrix renders and validates every supported combination of registry and CI system.
- Real pushes succeed:
  - to GHCR
  - to ECR, using OIDC from GitHub Actions, with a test account Omar provides
  - to a local `registry:2` or Harbor container in CI (`generic`)
- A rootless build passes on a runner without privileges.

### M23: Deploy stage

Build:

- **Modes,** set for each target:
  - `helm`: install or upgrade the chart into the target namespace, set the image tag to the commit SHA, wait for the rollout, and roll back on failure. Check the current flag names in Helm 4.
  - `gitops`: update the image tag in the environment repo.
- **`when`:** `default-branch`, `manual`, or `tag`. `manual` uses the CI system's own gate:
  - GitHub: environments with required reviewers (check availability for private repos on the team's plan)
  - GitLab: protected environments (paid tiers) or a manual job
  - Azure Pipelines: environment approvals
  - Jenkins: an `input` step
- **Cluster credentials:**
  - Use OIDC where possible: EKS, AKS, and GKE from GitHub Actions and GitLab CI.
  - Otherwise, use a kubeconfig stored in the CI system, named in the PR.
  - Each target deploys only to its own namespace.
- **Image tag.** Deploys always set the image tag to the commit SHA, which fixes P5.
- **After deploy,** the pipeline prints the rollout status. In v0.5.0, M9c adds the agent watching each release.

Done when:

- In a GitHub Actions run with a kind cluster:
  - a staging deploy on the default branch succeeds,
  - a failed rollout rolls back,
  - a production target waits for its gate.
- `gitops` mode updates an environment repo.

### M24: Jenkins and Azure Pipelines

Build:

- **Jenkins:** a declarative `Jenkinsfile` with every stage. It builds on an agent that has Docker, or with BuildKit in a Kubernetes pod agent.
- **Azure Pipelines:** an `azure-pipelines.yml` with stages and environments. Service connections are named in the PR.
- **The CI system doesn't depend on where the code lives.** For example, a GitHub repo can use Jenkins or Azure Pipelines.
- **Verification in CI** for these two needs their read connectors (M19, v0.6.0). Until those exist, they use local verify.

Done when:

- The `Jenkinsfile` runs for a sample app in a throwaway Jenkins container in CI.
- The Azure Pipelines file validates against Microsoft's published schema and runs once in a test organization Omar provides.

### M25: Ship from Slack and the console, verified in CI

Build:

- **Triggers:**
  - Slack: a mention or a command, such as "ship acme/checkout-api".
  - Console: a Ship page. Pick the repo and branch, see the detected stack, the toggles that apply, and the files to be written, then approve.

  Approvals follow the environment rules from M10 and M11, instead of the terminal-only rule.

- **`verify: ci`:**
  1. Push a `kodra-agent/ship-<id>` branch and open a draft PR.
  2. Watch the run through the CI connector.
  3. On failure, read the failing job's log as untrusted data, and push fixes to generated files only, on that branch only, up to `--max-fixes` times.
  4. When the run passes, mark the PR ready for review.

  One approval covers the branch, the draft PR, and the bounded fix commits, and the preview says exactly that.

- **On the Kubernetes target,** `ship` works only with `verify: ci`, because the agent never has a Docker socket there.
- **Progress** posts to the Slack thread or the console page.

Done when:

- A ship started in Slack and one started in the console each end in a ready PR, verified in GitHub Actions and in GitLab CI.
- A failing generated Dockerfile is fixed on the branch within the limit.
- On Kubernetes, `verify: local` is refused with a reason.

---

### M27: Scheduled checks and the daily digest (moved from M15)

See `docs/checks.md`.

- **`spec.checks`:** schedules (a local time, days, and a time zone) that post a digest to Slack and the console Overview, with the audit chain head. Every check is read-only, never calls the model, and is skipped when its connector is off.
- **Built:** pods failing, pending, not ready, or restarting; deployments short of replicas; warning events; failing pipelines on default branches; failed Jenkins jobs; databases down or degraded; firing alerts; and the agent itself (audit chain, budget, unanswered approvals). They are rules over the Dashboard's read cards, so there is no new read path.
- **The digest** separates new, ongoing, and fixed (state in `checks.json`), keeps a problem open when its check could not run, and can stay quiet when clean. The console has Run now and Ask in chat; `kodra-agent check` prints it, and `--post` posts it.

Differences from the candidate:

- No cost cap per run: the digest uses no model, so a run costs nothing.
- Paused changes do not stop the checks: they only read, like chat.

Done when each check has fixtures for both "found" and "clean", and a digest posts in the Slack test setup.

### M27b: More checks

- expiring certificates, read from cert-manager `Certificate` status and by checking the TLS of Ingress hosts, never by reading Secrets
- volumes filling up (kubelet volume metrics)
- deprecated API use (API server metrics, when they are scraped)
- rightsizing: seven days of usage compared with requests and limits

Done when each has fixtures for both "found" and "clean".

---

## 7. Candidates after launch: from diagnosis to fix, measured

Not scheduled. M16 still comes before M9b if both are picked.

### M16: Evaluation suite

- **Scenarios.** 15 to 20 scenarios on kind in `evals/scenarios/<id>/`. Each holds the manifests, the trigger (an alert or a question), the expected root-cause facts, and the actions that must not be proposed. Start with:
  - missing environment variable
  - OOMKilled
  - bad image tag
  - private registry authentication failure
  - failing readiness probe
  - Service selector with no endpoints
  - PVC Pending
  - DNS failure
  - missing ConfigMap key
  - failing init container
  - quota exceeded
  - unschedulable pod
  - HPA at its limit
  - liveness probe too aggressive
  - expired certificate
  - a release that returns 500s
  - NetworkPolicy blocking traffic
  - wrong `targetPort`
- **Runner.** `pnpm eval --provider <p> --model <id>` runs deterministic checks first, then an optional rubric graded by a fixed model.
- **Nightly workflow** for the providers and budget Omar sets (section 10). Each run produces results as JSON and a Markdown report.
- **`docs/model-compatibility.md`,** generated from real runs only, dated, with exact model ids. No hand-written numbers.

Done when the suite runs locally against Ollama and in CI against one hosted provider, and produces a report.

### M9b: Kubernetes fixes with guardrails

- **Narrow built-in tools:** rollout restart, rollout undo to the previous revision, and scale within bounds.
- **Admission policy.** Add a ValidatingAdmissionPolicy to the chart. It needs Kubernetes 1.30 or newer; the chart detects support and warns when it's missing.
  - It rejects changes by the agent's ServiceAccount to security-relevant fields: volumes, `serviceAccountName`, `automountServiceAccountToken`, pod and container `securityContext`, host namespaces, init and ephemeral containers, and node placement.
  - It is the backstop if an approval is fooled, or if a server in the pod misuses the token (F9).
- **Previews** run a server-side dry run (`dryRun=All`) and show the resulting diff. If the dry run fails, no approval is requested.
- **Ownership:**
  - For resources managed by Argo CD or Flux (detected from their tracking labels and annotations), propose a PR to the GitOps repo instead of patching the cluster.
  - For resources managed by Helm, warn that the next `helm upgrade` overwrites a direct change.
- **Downtime.** Warn when a restart would cause downtime: one replica, or a PodDisruptionBudget that blocks the restart.
- **After the action,** watch the rollout, then report.

Done when, on kind:

- a restart and an undo each go through preview, dry run, approval, and verification;
- the admission policy rejects a template change that adds a hostPath volume;
- a Deployment managed through GitOps produces a PR proposal instead of a patch.

### M9c: Watch releases, judged by real signals

Deploys come from the pipeline's deploy stage (M23), GitOps, or people. The agent watches them all and needs no deploy permissions of its own.

- **Detect new releases** in the configured namespaces: a new ReplicaSet revision, a Helm release revision, or a GitOps sync.
- **Healthy** means the rollout completed, and error rate, p95 latency, and restarts stay within thresholds compared with the previous version for N minutes (default 10).
  - Query templates cover common sources: Spring Boot Micrometer, ingress-nginx, and Istio.
  - Each app can also have its own PromQL.
- **On regression,** propose the rollback for approval, using the matching path:
  - rollout undo (M9b)
  - `helm rollback`
  - a revert PR to the GitOps repo

  Never roll back automatically.

- **Report** each release's result in Slack and the console.

Done when, on kind with Prometheus, a healthy release is confirmed and a release returning errors produces a rollback proposal.

---

## 8. Candidates after launch: more teams, more ways to extend

Not scheduled.

### M17: Custom actions

- **Definitions.** Teams declare their own operations in `actions.yaml` next to the config. Each action has a name, a description for the model, typed parameters (enums, patterns, ranges), a risk class, and the approval rules of its environment.
- **Two kinds to start.** No free-form shell.
  - `http`: a method and path on an allowlisted base URL, with headers from secret references
  - `kubernetes`: restart, scale, or annotate a named kind in allowed namespaces, under the M9b admission policy
- **Docs** with three examples: flushing a cache through an internal admin API, toggling a feature flag, and scaling a worker within bounds.

Done when actions appear as tools, invalid parameters are refused before approval, and every action is audited like any other write.

### M18: Memory, runbooks, and postmortem drafts

- **Investigation memory.** Each finished investigation stores its summary, root cause, fix, and verification result locally. New investigations get similar past ones as labeled context, for example "this alert fired three times last month; the fix was X". Use keyword search (BM25) by default, so memory works offline.
- **Runbooks.** Index Markdown runbooks from a repo the agent already reads, or from a mounted folder, and expose the index as a read tool.
- **Postmortem drafts.** Build them in Markdown from the audit log and the investigation: timeline, actions, approvals, verification, and follow-ups.
  - Every statement must be tied to audit records.
  - A draft can optionally be proposed as a PR to a postmortems repo.

Done when a repeated kind scenario brings up the earlier investigation, and a postmortem draft cites only audit records.

### M19: Connectors for more teams

Build in this order. Each connector follows the process in `CLAUDE.md`: license and maintenance check, every tool classified, and a doc in `docs/connectors/`.

1. **Microsoft Teams.** Check the current bot hosting requirements first. If Teams needs an inbound endpoint, document the options and keep console approvals as the fallback.
2. **Azure DevOps** (Repos and Pipelines). This unlocks `verify: ci` for Azure Pipelines (M24).
3. **Jenkins:** builds and logs. Triggering a build is a write. This unlocks `verify: ci` for Jenkins (M24).
4. **Argo CD and Flux:** status and history. Sync and rollback are writes.
5. **PagerDuty:** incidents as triggers, and the on-call person suggested as approver. Check Opsgenie's status before adding it, because Atlassian has announced it is being retired in favor of Jira Service Management.
6. **Elasticsearch or OpenSearch, and Splunk,** for logs.
7. **.NET in the ship flow:** detection, a Dockerfile template that runs as the image's non-root user, its test and lint commands in the stage registry, and a sample app in `examples/ship`.

### M26: Onboard a repo

`kodra-agent onboard <repo|dir>`: what a DevOps engineer does first with a new repo. See `docs/onboard.md`.

- **Understand (read-only).** From file contents only: the stack, services in a monorepo, what the app depends on (databases, caches, queues, storage), the environment variables it reads (secret-like names flagged), committed credentials (file, line, and rule, never the value), migrations, tests, and gaps in an existing Dockerfile, CI, or lockfile. Then questions for the team.
- **Act (one approval).** The report is printed and its risks and questions go to the Slack channel. The ship flow then runs with what it found: the chart lists the settings and loads secrets from a Secret the team creates (`envFromSecret`), and `ONBOARDING.md` joins the PR. An unsupported repo gets the report only.

Done when the report is right on the sample repos and the fixtures (a monorepo, an unsupported stack, a committed credential, settings in each language), one approval opens the PR with the report, and the credential's value appears nowhere.

### M28: Set up every connector from the console

Nobody edits `kodra-agent.yaml` or `.env`, or copies files by hand, once the agent runs. See `docs/console.md`.

- **Steps in the manifests.** Every secret, and settings like a bastion's host key, says how to get it: sentences, links (prefilled token pages where the forge supports them), and commands for Linux, macOS, and Windows (PowerShell), filled with the agent's own settings. Commands produce a value or a file; nothing runs them.
- **File secrets in the console.** A kubeconfig or an SSH key is pasted or uploaded, its shape checked, the connector's own check run with it, then saved as an owner-only file in the bundle (Compose) or in the agent's Secret (Kubernetes), with the config pointed at it.
- **What is missing** shows on each connector. EKS kubeconfigs that run `aws eks get-token` get optional AWS keys on the Kubernetes connector.

Done when every available connector's secrets have steps (a test), a kubeconfig and a tunnel key go from the console to a working connector without a file edit, and a broken file is refused in plain words.

### M29: Guardrails

DevOps practice for an agent that can change things: least privilege, small blast radius, and limits on the host. See `docs/approvals.md` and `docs/connectors/kubernetes.md`.

- **Least privilege.** A kubeconfig that is cluster-admin, reads Secrets, or changes deployments in every namespace is refused when tested and at startup, unless the connector sets `allowBroadCredentials`.
- **Blast radius.** `spec.limits.maxWritesPerHour` (default 10), one change at a time per environment, and scaling to zero or by more than half counts as destructive.
- **Host limits.** The Compose bundle caps memory, CPU, and processes, and rotates logs.

### M30b: Everything in the console

Every setting in kodra-agent.yaml is in Settings: profile and approval rules, environments and freezes, checks and alert limits, writes per hour, named models and their keys, the proxy and image mirrors, data protection, observability, and keeping a broad credential. Slack `@name` approvers are looked up in the console. Health runs every doctor check and verifies the audit chain. See `docs/console.md`. Only the builder's Docker socket stays in docker-compose.yml, on purpose.

### M30a: Onboard from the console

The Repos page: pick a configured repo, Analyze (the report, posted to Slack), then Open pull request after one approval. It runs in the running agent with its approvals and Slack, without Docker: the pull request's CI builds the image. See `docs/onboard.md`.

### M29b: After a change, and secret hygiene

- **Watch each change.** An approved Kubernetes scale is followed until its pods are ready (up to five minutes, in the background). If it does not settle, approvers are told in Slack with the change that puts it back, which needs approval again.
- **Secrets in the digest.** Expired (critical), expiring within 14 days, or set more than 90 days ago, from the secret itself (kubeconfig tokens and certificates, JWTs), the console's audit records, and file times.

---

## 9. Status

Update this table at the end of every milestone.

| Milestone                                            | Release      | Status      | PR  |
| ---------------------------------------------------- | ------------ | ----------- | --- |
| M10 Profiles, environments, and approvals            | v0.3.0       | Done        | #36 |
| M11 Change control                                   | v0.3.0       | Done        | #37 |
| M12 Works on any network                             | v0.3.0       | Done        | #38 |
| M13 Data protection and model routing                | v0.3.0       | Done        | #39 |
| M14 Trust and observability                          | v0.3.0       | Done        | #40 |
| Release v0.3.0                                       | v0.3.0       | Done        | #42 |
| Publish the configurator at build.kodra.io/agent     | v0.3.0       | Not started |     |
| M15 Value on day one (the demo)                      | After launch | Deferred    |     |
| Design partners: five to ten, notes in docs/partners | After launch | Not started |     |
| M26 Onboard a repo                                   | After launch | Done        | #67 |
| M27 Scheduled checks and the daily digest            | After launch | Done        | #68 |
| M28 Set up every connector from the console          | After launch | Done        | #71 |
| M29 Guardrails                                       | After launch | Done        | #76 |
| M29b After a change, and secret hygiene              | After launch | Done        | #78 |
| M30a Onboard from the console                        | After launch | Done        | #80 |
| M30b Everything in the console                       | After launch | Done        | #81 |

Candidates after launch, not scheduled: M27b (more checks); M20 to M25 (pipelines); M16, M9b, M9c (diagnosis to fix); M17, M18, M19 (more teams).

### Parked branches

Open branches stay unmerged until the gate opens (PLAN.md). None are open now. The launch plan named `feature/console-onboard-m30a` as parked, but it was merged as #80 (`fa279a8`) on 24 October 2026, and `feature/console-everything-m30b` was merged as #81 (`090243d`) the same day, both before the plan was adopted. They stay merged.

---

## Ideas

New ideas found while the gate is closed. Each one waits here until Omar picks it after the gate opens.

- None yet.

---

## 10. Decisions

### In effect

| Decision      | Value                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| Profile names | `starter`, `team`, `strict` (since M10)                                          |
| Launch        | v0.3.0 with M10 to M14; the M15 demo deferred                                    |
| Focus         | No new hardening before launch; after launch, design partners choose (section 1) |

### Open (Omar confirms before the milestone named)

| #   | Decision                                                                                      | Needed before         | Proposed default                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Security reporting for `SECURITY.md` (decided in M14: GitHub private vulnerability reporting) | Done                  | -                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | What comes after launch                                                                       | After design partners | Chosen from partner notes (section 5); pipelines are the likely first pick                                                                                                                                                                                                                                                                                                                       |
| 3   | Deploy in the starter profile                                                                 | M20                   | Available but off                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | Image scanner and SBOM format                                                                 | M21                   | Trivy, pinned; SPDX JSON                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | Test accounts                                                                                 | M21                   | A GitHub org for real pipeline runs, an AWS account for ECR and EKS with OIDC, a GitLab test project, and an Azure DevOps organization                                                                                                                                                                                                                                                           |
| 6   | Evaluation budget                                                                             | M16                   | Which providers and models run nightly, and a monthly cap; API keys stored as CI secrets                                                                                                                                                                                                                                                                                                         |
| 7   | Where the paid line sits                                                                      | Before any `ee/` work | Safety is free; enterprise integrations are paid. Everything in this plan goes in the open core. Later, in `ee/`: single sign-on for the console, native SIEM connectors, ticketing integrations (ServiceNow, Jira Service Management), a fleet view across many agents, and support. This plan builds no `ee/` code, only clean extension points (audit sinks, approval hooks, console sign-in) |

---

## 11. Rules

- **Breaking changes are allowed until launch.** The product hasn't launched yet.
  - Keep `apiVersion: kodra.io/v1alpha1`.
  - Change the schema, the JSON Schema export, examples, configurator, bundle templates, chart, docs, and tests together in the same PR.
  - Write no migration code.

  After v0.3.0 ships, any breaking change needs Omar's approval and a migration note.

- **Stay industry-neutral.** No copy, doc, or example may assume one industry or one kind of customer.
- **Profiles set defaults, never limits.** The starter path gets no new required steps.
- **Test refusals.** Every new control has tests for what it refuses, not only for what it allows.
- **The golden rules in `CLAUDE.md` always apply.**
  - Investigations, scheduled checks, and evaluations stay read-only.
  - Fixes stay proposals.
- **`ship` never edits application code or tests.** The model may fix generated files only (the Dockerfile and the pipeline file), and only while keeping the pinning and non-root rules.
- **Verify against current docs** before building on any third-party API or behavior, including:
  - Node's proxy variables
  - Slack Bolt
  - ValidatingAdmissionPolicy
  - Argo CD and Flux tracking metadata
  - Microsoft Teams bot hosting
  - GitHub Actions OIDC and environments
  - GitLab `id_tokens` and protected environments
  - Azure Pipelines environments and workload identity federation
  - the Jenkins Kubernetes plugin
  - Helm 4 flags
  - Trivy, Syft, and cosign
  - rootless BuildKit and Buildah
- **Workflow:**
  - One milestone per branch and PR, with one user-visible result.
  - Plan first, and wait for Omar's approval.
  - Stop at the end of each milestone with tests green, a summary, how to try it, and open questions.
  - Update the status table (section 9) and the findings (section 3) in the same PR.

---

## 12. Out of scope

- A hosted SaaS, accounts, billing, license keys, and `ee/` features (decision 7)
- Changes without approval
- Running pipelines on Kodra's infrastructure. Everything runs in the team's own CI.
- Changing existing pipelines from `ship`. They are kept, and the PR lists the missing stages. Edits stay a chat request through proposed changes.
- Bitbucket (there is no connector), repos with several services, and Azure and GCP cloud connectors
- Vault or cloud secret-manager references. The chart's `existingSecret` already works with External Secrets Operator and similar tools.
