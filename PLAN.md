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

---

## Status

| Step                                        | Status                                    | PR  |
| ------------------------------------------- | ----------------------------------------- | --- |
| L0 Reset                                    | Done                                      | #82 |
| L1 Launch narrower                          | Done                                      | #87 |
| L2 Close the red flags                      | Done                                      | #84 |
| L3 Proof: scenarios, evals, and the demo    | Merged; the hosted run is still open      | #85 |
| L4 Publish and release v0.4.0               | In progress: deploy and hallway test next | #86 |
| L5 Partner zero: Kodra.io                   | Not started                               |     |
| L6 Design partners                          | Not started                               |     |
| Gate open: Omar picks the next roadmap item | Not started                               |     |

## Rules

- The golden rules in `CLAUDE.md` always apply.
- One step per branch and PR. Plan first and wait for Omar's approval. Stop at the end with tests green, a summary, and how to try it, then update the status table.
- Copy stays industry-neutral, and profiles set defaults, never limits.
- If it isn't in this file, it doesn't get built.
