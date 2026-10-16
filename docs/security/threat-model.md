# Threat model

STRIDE for each part of Kodra AI Agent: Spoofing, Tampering, Repudiation, Information
disclosure, Denial of service, and Elevation of privilege. Each row names the threat, what
stops it, and where that is tested. What is not covered is in
[known limitations](../known-limitations.md).

## Assets and trust boundaries

- **Assets:** the credentials for your systems (model key, tokens, kubeconfig), your systems
  themselves (clusters, repos, monitoring), your data in them, and the audit log.
- **Trusted:** the people who can change the agent's config, environment, image, or host; the
  approvers you name.
- **Untrusted:** everything a tool returns (repo files, logs, issues, alerts, metrics), the
  model's output, people in the Slack channel who are not approvers, and the network.
- **Boundaries:** the agent container; each MCP server process inside it; the model provider;
  Slack; the console's browser session; the Docker socket (Compose builds only).

## Configurator (static site)

| STRIDE                 | Threat                                       | Mitigation                                                                                                                                        |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information disclosure | Secrets typed into the page                  | No secret input fields at all; the bundle has `.env.example` with names only. Rule 1.                                                             |
| Information disclosure | The page sends your choices somewhere        | Static only, CSP `default-src 'none'`, `connect-src 'none'`; the bundle is zipped in the browser. Every e2e test fails on any off-origin request. |
| Tampering              | A generated bundle runs code chosen per user | One image for everyone; behavior comes only from `kodra-agent.yaml` (rule 2), validated against the schema.                                       |

## Setup (`init`, `.env`, Secrets)

| STRIDE                 | Threat                                     | Mitigation                                                                                                                      |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Information disclosure | Secrets shown or logged while entered      | Hidden input; each value is checked with a read-only probe and registered with the redactor as soon as it is read.              |
| Information disclosure | `.env` readable by other users             | Written with owner-only permissions; `doctor` fails a `.env` others can read.                                                   |
| Spoofing               | `@name` approvers resolved to someone else | `init` turns `@name` into Slack user ids once, so a renamed account cannot take the role; `doctor` flags names left unresolved. |

## Agent runtime: policy and approvals

| STRIDE                 | Threat                                                   | Mitigation                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elevation of privilege | The model calls a write or destructive tool on its own   | `decide()` checks every call: reads run, writes wait for approval, destructive tools are blocked (or need approval with `require-approval`), unclassified tools are blocked. `src/policy.test.ts`.                                            |
| Elevation of privilege | Instructions planted in a log, file, issue, or alert     | Tool output is wrapped as untrusted data and escaped (`wrapUntrusted`), the system prompt says never to follow it, and every change still needs a human approval. Alert investigations are read-only.                                         |
| Elevation of privilege | A tool aimed outside its scope (another repo, namespace) | Manifest guards (`repo-in-setting`, namespace guards, `not-default-branch`) are checked by the host before a call, whatever the server's own filters do.                                                                                      |
| Elevation of privilege | The agent changes itself (its RBAC, Deployment, Secret)  | The `not-self` guard refuses the agent's own objects for every connector tool.                                                                                                                                                                |
| Spoofing               | Someone who is not an approver approves                  | Votes are checked against Slack user ids or `console:<name>` accounts; the requester's own vote does not count unless `allowSelfApproval` (off for production in the team profile, off everywhere in strict); `minApprovers` per environment. |
| Tampering              | An approval reused for a different change                | One request covers one exact call and one environment; `propose_change` re-reads each file before writing it and stops if it changed.                                                                                                         |
| Denial of service      | A runaway conversation burns the model budget            | Step, token, and time limits per question; a monthly budget; the pause switch.                                                                                                                                                                |
| Repudiation            | A change nobody admits to                                | Every request, vote, override, and tool call is in the audit log with the Slack id or console account.                                                                                                                                        |

## Connectors and MCP servers

| STRIDE                 | Threat                                               | Mitigation                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tampering              | A swapped or compromised server binary or package    | Each server is pinned by version and SHA-256 (or a lockfile for PyPI and npm) and preinstalled in the image; `pnpm mcp:fetch` re-verifies.                                      |
| Information disclosure | A server reads another connector's secrets or `.env` | Each server starts in an empty private folder with a minimal environment plus only its own secrets; secrets go in environment variables or 0600 files, never on a command line. |
| Elevation of privilege | A server update adds a new write tool                | Tools without a risk are blocked; `src/real-servers.e2e.test.ts` fails when a pinned server offers an unclassified tool.                                                        |
| Information disclosure | A server phones home                                 | Usage reporting is turned off where a server has it (`--usage-stats=disabled` for Grafana); the chart's NetworkPolicy limits egress.                                            |

## Model provider

| STRIDE                 | Threat                                                  | Mitigation                                                                                                                                   |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Information disclosure | Secrets in tool output reach the model                  | The redactor masks every registered secret, including split across stream pieces; canary tests fail on a leak.                               |
| Information disclosure | Customer data (cards, IBANs, emails, phones) reaches it | `spec.dataProtection` masks it with checksums and stable placeholders before any model call.                                                 |
| Information disclosure | Production data goes to a public model                  | `environments[].model` pins an environment to its own model (a local one, for example); a conversation that would mix two models is stopped. |
| Tampering              | The model answers with harmful advice                   | It can only act through tools, under the policy above; its answers are shown as its answers.                                                 |

## Slack

| STRIDE                 | Threat                                                  | Mitigation                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A message pretends to be from an approver               | Votes are button clicks that arrive as interaction events over the app's own Socket Mode connection, with the user id Slack gives, never the text of a message. |
| Information disclosure | Answers and approval requests seen by the whole channel | Everything posted is redacted and masked; pick a private channel for production.                                                                                |
| Denial of service      | The agent cannot be reached from outside                | Socket Mode needs no inbound connection; approvals also work from the console.                                                                                  |

## Console

| STRIDE                 | Threat                                | Mitigation                                                                                                                                            |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Someone signs in without a token      | Token sign-in; sessions are HMAC-signed cookies keyed by each account's token hash, so changing a token ends its sessions.                            |
| Tampering              | Cross-site requests from another page | Every POST needs the session, a matching `Origin`, and the `x-kodra-console: 1` header.                                                               |
| Information disclosure | The console reached from the network  | Compose publishes it on `127.0.0.1` only; the chart makes a ClusterIP Service (port-forward).                                                         |
| Elevation of privilege | A viewer changes settings or approves | Settings and approvals need a `console:<name>` approver account; secrets are saved only after their probe passes; a saved config must validate first. |

## Audit log

| STRIDE                 | Threat                                 | Mitigation                                                                                                                                        |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tampering              | A record edited, deleted, or reordered | A SHA-256 hash chain across records and rotations; `kodra-agent audit verify`, the doctor `audit chain` row, and the console's head hash show it. |
| Repudiation            | The whole log rewritten from the start | Detected only against a copy kept elsewhere: `spec.audit.stdout` for a log collector, or a noted head hash.                                       |
| Information disclosure | Secrets or customer data in records    | Every line goes through the redactor and the data masker before it is written; files are owner-only.                                              |

## Ship and the Docker socket

| STRIDE                 | Threat                                        | Mitigation                                                                                                                                   |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Elevation of privilege | The Docker socket gives near-root on the host | Only with Docker build access; on Compose only the one-shot `kodra-builder` mounts it, never the always-on agent. The chart never mounts it. |
| Tampering              | Generated files pushed to a default branch    | Pushes go to a new branch and a pull request, checked by the `not-default-branch` guard; push and PR need one approval.                      |
| Information disclosure | The git token in process arguments or config  | Git gets the token only as an `http.extraHeader` environment variable, with the user's git config off.                                       |

## Image and supply chain

| STRIDE                 | Threat                             | Mitigation                                                                                                                                             |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tampering              | A forged image or chart            | Both are signed with cosign (keyless, GitHub OIDC) and released with an SPDX SBOM, provenance attestations, and `SHA256SUMS`.                          |
| Tampering              | A dependency changed after release | Exact versions everywhere; pnpm refuses versions younger than its minimum release age; base images and CI actions are pinned by digest and commit SHA. |
| Tampering              | A secret committed to the repo     | gitleaks scans the full history in CI.                                                                                                                 |
| Elevation of privilege | Container escape or write access   | Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`, seccomp `RuntimeDefault` on Kubernetes.                       |

## Metrics and traces

| STRIDE                 | Threat                                   | Mitigation                                                                                                                                                        |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information disclosure | Content in a label or span attribute     | Labels and attributes come only from fixed lists (connector ids, risks, decisions, configured model labels); anything else is `other`. Tests feed hostile values. |
| Information disclosure | `/metrics` read by anyone who reaches it | Counts only; not published by Compose; a ClusterIP Service on Kubernetes.                                                                                         |
| Information disclosure | Traces sent to a third party             | Off by default, and sent only to the endpoint you set (golden rule 7: no telemetry).                                                                              |
