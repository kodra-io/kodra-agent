# Kodra AI Agent: v0.2 Plan

Addendum to `SPEC.md`. Owner: Omar Al-Amad.
Based on a review of `main` at `44e2f83` (13 October 2026).
Status: ready to build once the decisions in section 7 are confirmed.

---

## 1. Why this round

v0.1.3 already delivers the MVP and more: the full flow works and the safety model is solid. This round gets it ready for many kinds of organizations before launch.

- **One product, many kinds of users.** Solo developers and startups, growing product teams and agencies, and large or regulated organizations (finance, insurance, healthcare, telecom, government, education) all use the same agent. Configuration is what differs between them, not code.
- **Fix what blocks real environments:** corporate proxies, private registries, OpenShift, and customer data in logs.
- **Make approvals hold up to review** in organizations that separate the person who asks for a change from the person who approves it.
- **Give value on day one,** before the first incident.

The product has not launched, so this round may make breaking changes to `kodra-agent.yaml`, the bundle, and the chart (section 8).

---

## 2. Review findings (verified at 44e2f83)

### Keep (do not regress)

- Tool gating in code:
  - Tools are allowlisted.
  - The Kubernetes server config denies Secrets, ServiceAccounts, and RBAC kinds.
  - Namespace and repo guards check every call.
  - Generic create, update, exec, and delete tools are classed destructive and never exposed.
- MCP host isolation: each server gets a private temp folder and a minimal environment holding only its own connector's secrets. Secrets go in env vars or 0600 files, never argv. Extend this isolation, never loosen it.
- Tests: the real-servers test that fails on any unclassified tool, and the canary test for leaked secrets.
- Write safety: Slack approvals are checked by user ID, every file is re-read before a write, and nothing is written to a default branch.
- Deployment safety:
  - On Compose, a settings change restarts the agent by exiting with code 75.
  - The agent's permissions on its own resources are limited by `resourceNames`.
  - The chart runs `replicas: 1` with the `Recreate` strategy.
- MCP server binaries are SHA-256 checked and installed into the image at build time.

### Change

| #   | Finding                                                                                                                                                                                                                                            | Where                                                                                                     | Fixed in |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| F1  | No proxy or custom CA support anywhere. MCP servers start with a minimal environment, so proxy and CA variables never reach them even when set.                                                                                                    | `apps/agent/src/mcp/host.ts` (`childEnv`), every HTTP client                                              | M12      |
| F2  | An approver can approve their own request. One approver list and one rule set cover every change.                                                                                                                                                  | `apps/agent/src/approvals.ts`, `apps/agent/src/slack/approvals.ts`, `apps/agent/src/console/approvals.ts` | M10      |
| F3  | `@name` approvers are matched at startup against usernames and display names, which users can edit.                                                                                                                                                | `apps/agent/src/slack/approvers.ts`                                                                       | M10      |
| F4  | The redactor masks secrets and token patterns only. Customer data in logs (card numbers, IBANs, emails, phone numbers) reaches the model, the audit log, Slack, and the console.                                                                   | `apps/agent/src/redactor.ts`                                                                              | M13      |
| F5  | The audit log is append-only by convention only: no hash chain, no way to detect edits, and no export path.                                                                                                                                        | `apps/agent/src/audit.ts`                                                                                 | M14      |
| F6  | The agent has no metrics or traces of its own.                                                                                                                                                                                                     | New                                                                                                       | M14      |
| F7  | With build access, the always-on `kodra-agent` service mounts the Docker socket, so Slack, the console, the model loop, and every MCP server share root-level access to the host.                                                                  | `packages/templates/src/bundle.ts`                                                                        | M14      |
| F8  | The chart has no NetworkPolicy.                                                                                                                                                                                                                    | `charts/kodra-agent/templates`                                                                            | M12      |
| F9  | `rbac.write` grants `patch` on Deployments, which can change the whole pod template (volumes, service account, security context). Every process in the pod can read the ServiceAccount token. M9b's restart and undo will rely on this permission. | `charts/kodra-agent/templates/rbac.yaml`                                                                  | M9b      |
| F10 | There is only one evaluation scenario (a crashloop).                                                                                                                                                                                               | `apps/agent/scripts/kind-test.ts`                                                                         | M16      |
| F11 | There is no `SECURITY.md`, threat model, data-flow page, or known-limitations page.                                                                                                                                                                | `docs/`                                                                                                   | M14      |

---

## 3. Profiles and environments

### Profiles

`spec.profile` picks defaults suited to a kind of organization. Profiles set defaults only: every value can be overridden in `kodra-agent.yaml`, the configurator, or the console.

|                                         | `starter`                                  | `team`                                       | `strict`                                                              |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------- |
| For                                     | One person or a small team getting started | Several people and more than one environment | Regulated, audited, or change-managed organizations                   |
| Approving your own request              | Allowed                                    | Allowed, except in production                | Never                                                                 |
| Approvers needed                        | 1                                          | 1                                            | 2 in production, 1 elsewhere                                          |
| Change reference on approvals           | Off                                        | Off                                          | Required in production                                                |
| Changes to policy, approvers, or access | Audited                                    | Audited and announced to all approvers       | Audited, announced, and approved by a second approver                 |
| Customer-data redaction                 | Card numbers, IBANs                        | Adds emails and phone numbers                | Same as team                                                          |
| Kubernetes NetworkPolicy                | Off                                        | On                                           | On; when a proxy is set, outbound traffic goes through the proxy only |
| Daily checks digest                     | On                                         | On                                           | On                                                                    |

Freeze windows, model routing, custom redaction patterns, and every other control work in all profiles.

Rules:

- The starter path gets no new required steps. The package test's starter run needs no more inputs than it did in v0.1.3.
- `doctor` and the configurator reject rules nobody can satisfy. Example: production forbids self-approval but lists only one approver. The message should read: "Production changes need someone other than the requester. Add a second approver."

### Environments

An environment is a named group of Kubernetes namespaces, and optionally repositories, with its own rules.

- A tool call belongs to an environment when its namespace or repo argument matches.
- The policy engine finds those arguments through the manifests' existing guard metadata.
- Any call outside every environment uses `spec.policy`.

```yaml
apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: shop-platform-agent
spec:
  profile: team # starter | team | strict
  target: kubernetes
  model: # the default model
    provider: anthropic
    name: '<model-id>'
    apiKey: ${env:ANTHROPIC_API_KEY}
  models: # optional named models (M13)
    local:
      provider: ollama
      name: '<model-id>'
      baseUrl: http://ollama.ai-tools:11434
  # connectors: unchanged, omitted here
  environments:
    - name: production
      namespaces: [checkout, payments]
      repos: [acme/checkout-api]
      model: local # data from this environment only goes to this model (M13)
      approvers: ['U0123ABCD', 'U0456EFGH', 'console:omar']
      approvals:
        minApprovers: 1
        allowSelfApproval: false
        requireChangeRef: true # M11
        changeRefPattern: '^CHG[0-9]{7}$'
      freezes: # M11
        - name: weekend
          timezone: Asia/Amman
          weekly: { from: 'Thu 18:00', to: 'Sat 23:59' }
        - name: year-end
          timezone: Asia/Amman
          dates: { from: '2026-12-28', to: '2027-01-02' }
    - name: staging
      namespaces: [staging]
  policy: # the default for anything outside an environment
    approvals:
      approvers: ['U0123ABCD', 'console:omar']
      expiresAfterMinutes: 15
    destructiveActions: deny
  dataProtection: # M13
    redact: [cards, ibans, emails, phones]
    patterns:
      - name: customer-id
        regex: "\\bCUST-[0-9]{8}\\b"
  network: # M12
    proxy:
      https: ${env:HTTPS_PROXY} # a secret reference, because proxy URLs can hold credentials
      noProxy: 'localhost,127.0.0.1,.svc,.cluster.local'
    caBundleFile: /etc/kodra-agent/ca/ca.pem
  checks: # M15
    schedule: '0 9 * * 0-4' # Sunday to Thursday at 09:00
    timezone: Asia/Amman
    deliver: [slack, console]
```

---

## 4. Milestones before launch (v0.3.0)

### M10: Profiles, environments, and approvals

Build:

- **Docs.** Refresh `SPEC.md` so it describes the product as built (console, proposed changes) plus profiles and environments. Point SPEC section 12 to this file for the current round. Update `CLAUDE.md` wherever commands or rules change.
- **Schema.** Add:
  - `spec.profile`
  - `spec.environments`, each with a name, namespaces, repos, approvers, and approvals
  - the approval rules `minApprovers` and `allowSelfApproval`

  One pure function resolves the effective policy (profile defaults first, then explicit values). It is the only place defaults live, and the configurator, `doctor`, and the agent all call it.

- **Environment matching** in the policy engine, using guard metadata (namespace and repo arguments).
- **Approvals:**
  - Every request records its requester: a Slack ID, a console account, the CLI user, or `agent:monitor` for alert investigations.
  - Self-approval is refused where it isn't allowed. An approval in the CLI counts as the requester's own.
  - `minApprovers` requires that many distinct approvers. Any denial ends the request, and the expiry covers the whole request.
  - Slack and the console show progress, for example "1 of 2 approved".
- **Approver identity:**
  - `init` resolves `@name` entries to Slack user IDs once, shows who matched, and saves the IDs.
  - At runtime only IDs are accepted.
  - `doctor` flags any name left in the config.
- **Configurator:**
  - A first step, "Who is this agent for?", presents the three profiles in plain language.
  - Next comes an environments step, shown by default for team and strict.
  - The review step and the bundle README state the effective rules for each environment.
- **Examples:** one example config per profile in `examples/`.

Done when:

- Tests prove that:
  - self-approval is refused where it should be,
  - two distinct approvals are needed where configured,
  - a denial ends the request,
  - only IDs are accepted at runtime,
  - rules nobody can satisfy fail validation with a readable message.
- Playwright covers the profile step in English and Arabic.
- The starter package test needs no new inputs.

### M11: Change control

Build:

- **Freeze windows** per environment, as weekly ranges and date ranges, each with a time zone.
  - During a freeze, writes in that environment are refused, and the reason is shown.
  - Break-glass: an approver can allow one change by giving a written reason. In `strict` the override needs two approvers.
  - Every override is audited and announced.
- **Change reference.** When `requireChangeRef` is on:
  - Approving requires a reference, entered in a Slack modal or a console field.
  - The reference is checked against `changeRefPattern` when one is set.
  - It is stored in the audit record and shown with the approval.
  - The agent makes no calls to ticketing systems (section 7).
- **Policy changes.** Any console save that touches the profile, environments, approvers, approval rules, access levels, data protection, or network settings is announced to all approvers with the diff. In `strict`, the save waits for a second approver before it applies.
- **Invariant.** No connector tool can change the agent's own config file, ConfigMap, Secret, or Deployment. Add a test that attempts it through every write-capable tool.

Done when tests cover:

- a write refused during a freeze, including in a time zone with daylight saving time,
- break-glass with one approver and with two,
- a missing or malformed change reference,
- a policy change in `strict` that waits for a second approver.

### M12: Works on any network

Build:

- **Config.** Add `spec.network.proxy` (`https`, `http`, `noProxy`) and `caBundleFile`.
  - Node reads its CA settings at startup, so the bundle and chart must set the matching environment variables on the container:
    - `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`, in upper and lower case
    - `NODE_USE_ENV_PROXY=1`
    - `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, and `GIT_SSL_CAINFO`
  - The chart adds the API server address and the cluster domains to `NO_PROXY` automatically.
  - The CA file is mounted from a ConfigMap or Secret on Kubernetes, and from a folder on Compose.
  - `doctor` checks that what the process sees matches the config.
- **Every client honors these settings:**
  - the agent's own fetch calls
  - Slack: check Bolt's proxy option for both the Web API and Socket Mode
  - every MCP server: add the proxy and CA variables to a host-level inherited list, so all servers get them, and register proxy credentials with the redactor
  - `git` in the ship flow
  - `helm`
  - `docker build`: pass the proxy as build arguments
- **Private registries:**
  - a registry override for the agent image, in both the chart and the Compose bundle
  - a `baseImageMirror` setting for the base images in the ship templates
  - a short air-gapped install guide: mirror one image and one chart (the MCP servers are already inside the image), and use a local model
- **OpenShift:**
  - The image runs under a random UID in group 0: writable paths belong to group 0 and are group-writable, and `HOME` is set explicitly.
  - The chart can leave `runAsUser`, `runAsGroup`, and `fsGroup` unset.
- **NetworkPolicy in the chart,** generated from the enabled connectors.
  - It allows DNS, the API server, and in-cluster targets taken from connector URLs.
  - Beyond those, it allows either the proxy alone (when one is set) or HTTPS to public addresses with private ranges blocked.
  - Standard NetworkPolicy cannot match hostnames, so also offer an optional CiliumNetworkPolicy with `toFQDNs` built from the connector hostnames.

Done when:

- A CI job runs the agent on a network whose only way out is a TLS-inspecting proxy with its own CA. In that job, `doctor` and one investigation pass, with each client reaching stand-in HTTPS and WebSocket endpoints:
  - Node fetch
  - the Slack Web API and Socket Mode
  - a Go server and a Python server
  - `git` and `helm`

  A client that ignores the proxy fails the job.

- A second job runs the image as `--user 1000680000:0`.
- Chart tests render the NetworkPolicy for each profile.

### M13: Data protection and model routing

Build:

- **Built-in detectors:**
  - `cards`: 13 to 19 digits with optional spaces or dashes, Luhn-checked
  - `ibans`: mod-97 checked
  - `emails`
  - `phones`: international format starting with `+` or `00`
  - plus custom `patterns`
- **Placeholders keep meaning.** Within one agent run, the same value always gets the same placeholder, for example `[email:7f3a]`. Placeholders come from an HMAC whose key is random, created at startup, and never stored. The model can still see that one customer appears in many errors.
- **Where redaction runs.** It runs after secret redaction, on everything sent to the model and on the audit log, Slack, and the console. Audit records count redactions per type and never record values.
- **Model routing:** named models (`spec.models`) and a `model` setting per environment.
  - Data from an environment that names a model only ever goes to that model.
  - Alert investigations pick the model from the alert's namespace before the first call.
  - In chat, a tool result can come from a pinned environment while the conversation uses another model. The conversation then switches to the pinned model before the result is sent, so the other model never sees it.
  - Two different pins in one conversation stop the turn with a clear message.

Done when:

- Fixtures of realistic log lines, using made-up data, are redacted correctly.
- False-positive tests pass on timestamps, UUIDs, image digests, trace IDs, ports, metric values, and Kubernetes resource versions.
- A routing test with a recording mock model proves a pinned environment's tool output never reaches the default model.

### M14: Trust and observability

Build:

- **Audit chain:**
  - Every record has `seq` and `prev`, where `prev` is the SHA-256 of the previous record's line. The chain continues across log rotation.
  - `kodra-agent audit verify` reports the first broken record, and `doctor` runs it.
  - The current chain head is shown on the console overview, and in the daily digest from M15, so rewritten history can be detected.
  - The option `audit.stdout: true` also writes each record, already redacted, to stdout as JSON for any log collector.
- **Metrics,** served on their own port:
  - tool calls by connector, risk, and decision
  - pending approvals and approval wait time
  - investigations and their duration
  - tokens and cost by model
  - connector health
  - errors
  - budget left

  No secrets or user content may appear in labels. The chart offers an optional ServiceMonitor and a PrometheusRule (connector down, model errors, approvals stuck, budget nearly spent). Ship a Grafana dashboard JSON in `dashboards/`.

- **Traces.** Optional OpenTelemetry traces, off by default: one span per turn, model call, and tool call, with no content in the attributes.
- **Docker socket.** The always-on service never mounts the socket. A separate one-shot `kodra-builder` service in a Compose profile mounts it, and `ship` runs there:

  ```
  docker compose run --rm kodra-builder ship <repo>
  ```

- **Security pack:**
  - `SECURITY.md`: supported versions and a reporting address that Omar provides
  - `docs/security/threat-model.md`: STRIDE for each component
  - `docs/security/data-flow.md`: "What leaves your network", for each connector and model provider. Add a test that fails when a manifest changes but this page doesn't.
  - `docs/known-limitations.md`
  - image verification steps (`cosign verify`, SBOM) in the README
  - `docs/security/review-brief.md`: where an outside reviewer should start

Done when:

- Editing, deleting, or reordering an audit record makes `audit verify` fail.
- The metrics appear in a kind test with Prometheus.
- The package test proves the always-on service has no socket mount.
- The data-flow test runs in CI.

### M15: Value on day one

Build:

- **`kodra-agent demo`:** one command that needs only Docker and a model key (or a local model). It:
  1. creates a throwaway kind cluster,
  2. deploys three broken workloads: a missing environment variable, an OOMKilled container, and a bad image tag,
  3. runs an investigation for each one and prints the findings.

  `--cleanup` removes everything. The demo runs as a one-shot service with the Docker socket, never inside the always-on service. If kind and kubectl make the main image much larger, ship a separate demo image. The configurator's starter profile offers a "Just trying it?" demo bundle.

- **Scheduled checks (`spec.checks`):** a schedule with a time zone, posting a digest to Slack and the console. Each check is read-only and is skipped when its connector is off:
  - restart loops and pods that are not ready
  - expiring certificates, read from cert-manager `Certificate` status and by checking the TLS of Ingress hosts, never by reading Secrets
  - volumes filling up (kubelet volume metrics)
  - deprecated API use (API server metrics, when they are scraped)
  - rightsizing: seven days of usage compared with requests and limits
  - failing pipelines on default branches
  - open alerts

  The digest separates new items from ongoing ones and has a cost cap per run. It can stay quiet when everything is clean.

Done when:

- The package test runs the demo end to end with a mock model.
- Each check has fixtures for both "found" and "clean".
- A digest posts in the Slack test setup.

### Launch

After M15:

1. Release v0.3.0. (v0.2.0 already shipped M8c and M9a on 13 October 2026.)
2. Publish the configurator at `build.kodra.io/agent`.
3. Start working with design partners.

The milestones below follow in order, adjusted to what design partners report.

---

## 5. Milestones after launch

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
- **Nightly workflow** for the providers and budget Omar sets (section 7). Each run produces results as JSON and a Markdown report.
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

### M9c: Deploy after ship, judged by real signals

- **Deploy mode** per environment: `helm` (install or upgrade into allowed namespaces) or `gitops` (a PR to the environment repo).
- **What "healthy" means.** The rollout completes, and error rate, p95 latency, and restarts stay within thresholds compared with the previous version for N minutes (default 10).
  - Query templates cover common sources: Spring Boot Micrometer, ingress-nginx, and Istio.
  - Each app can also have its own PromQL.
- **On regression,** propose the rollback for approval. Never roll back automatically.

Done when, on kind with Prometheus, a healthy release is confirmed and a release returning errors produces a rollback proposal.

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
2. **Azure DevOps** (Repos and Pipelines).
3. **Jenkins:** builds and logs. Triggering a build is a write.
4. **Argo CD and Flux:** status and history. Sync and rollback are writes.
5. **PagerDuty:** incidents as triggers, and the on-call person suggested as approver. Check Opsgenie's status before adding it, because Atlassian has announced it is being retired in favor of Jira Service Management.
6. **Elasticsearch or OpenSearch, and Splunk,** for logs.
7. **.NET in the ship flow:** detection, a Dockerfile template that runs as the image's non-root user, and a sample app in `examples/ship`.

---

## 6. Status

Update this table at the end of every milestone.

| Milestone                                   | Status      | PR  |
| ------------------------------------------- | ----------- | --- |
| M10 Profiles, environments, and approvals   | In review   | #36 |
| M11 Change control                          | Not started |     |
| M12 Works on any network                    | Not started |     |
| M13 Data protection and model routing       | Not started |     |
| M14 Trust and observability                 | Not started |     |
| M15 Value on day one                        | Not started |     |
| Launch: v0.3.0, configurator published      | Not started |     |
| M16 Evaluation suite                        | Not started |     |
| M9b Kubernetes fixes with guardrails        | Not started |     |
| M9c Deploy after ship                       | Not started |     |
| M17 Custom actions                          | Not started |     |
| M18 Memory, runbooks, and postmortem drafts | Not started |     |
| M19 Connectors for more teams               | Not started |     |

---

## 7. Decisions for Omar (confirm before M10)

| #   | Decision                   | Proposed default                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Profile names              | `starter`, `team`, `strict`                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Where the paid line sits   | Safety is free; enterprise integrations are paid. Everything in this plan goes in the open core. Later, in `ee/`: single sign-on for the console, native SIEM connectors, ticketing integrations (ServiceNow, Jira Service Management), a fleet view across many agents, and support. This round builds no `ee/` code, only clean extension points (audit sinks, approval hooks, console sign-in) |
| 3   | Launch cut                 | v0.3.0 after M15 (v0.2.0 shipped the console)                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Security reporting address | An address Omar owns, for `SECURITY.md`                                                                                                                                                                                                                                                                                                                                                           |
| 5   | Evaluation budget          | Which providers and models run nightly, and a monthly cap. Needs API keys stored as CI secrets                                                                                                                                                                                                                                                                                                    |

---

## 8. Rules for this round

- **Breaking changes are allowed before launch.**
  - Keep `apiVersion: kodra.io/v1alpha1`.
  - Change the schema, the JSON Schema export, examples, configurator, bundle templates, chart, docs, and tests together in the same PR.
  - Write no migration code.
- **Stay industry-neutral.** No copy, doc, or example may assume one industry or one kind of customer. Examples should cover different kinds of organizations.
- **Profiles set defaults, never limits.**
- **Test refusals.** Every new control has tests for what it refuses, not only for what it allows.
- **The golden rules in `CLAUDE.md` still apply.** Investigations, scheduled checks, and evaluations stay read-only.
- **Verify against current docs** before building on any of these:
  - Node's proxy and CA variables
  - Slack Bolt's proxy options
  - ValidatingAdmissionPolicy
  - OpenShift security context constraints
  - Argo CD and Flux tracking metadata
  - Microsoft Teams bot hosting
- **Workflow:**
  - One milestone per branch and PR.
  - Plan first and wait for approval.
  - Stop at the end of each milestone with tests green, a summary, how to try it, and open questions.
  - Update the status table in section 6.

---

## 9. Out of scope for this round

- Hosted SaaS, accounts, billing, license keys, and `ee/` features (section 7)
- Changes without approval: investigations, checks, and evaluations stay read-only, and fixes stay proposals
- Azure and GCP cloud connectors, and Bitbucket
- Vault or cloud secret-manager references. The chart's `existingSecret` already works with External Secrets Operator and similar tools.
