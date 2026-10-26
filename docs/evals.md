# Evaluations and the demo

One set of failure scenarios serves both the evaluation suite and `kodra-agent demo`. Each
scenario is a broken workload on a throwaway [kind](https://kind.sigs.k8s.io/) cluster, the
alert or question that starts the investigation, the root-cause facts a right answer states,
and what the agent must not do.

## Scenarios

`evals/scenarios/<id>/` holds:

- `manifests.yaml`: the workload, in a namespace named after the scenario, so all of them run
  side by side on one cluster.
- `scenario.yaml`:
  - `trigger`: a `question`, or an `alert` (labels and annotations). An alert becomes the same
    prompt `kodra-agent run` builds when Alertmanager reports it.
  - `ready`: what must be true of a pod before the agent is asked (`waiting` or `terminated`
    with a `reason`, `pending`, `running`, `not-ready`, or `restarted`).
  - `expect`: each fact passes when any of its patterns is in the answer (case-insensitive).
  - `mustNot`: a tool the agent must not call (`tool`, with an optional `args` pattern), or an
    action it must not recommend (`says`). A `says` match in a sentence with a negation before
    it ("do not remove the limit") does not count.
  - `update: true` with `update.yaml`: a second release, rolled out before the agent is asked.

| Scenario                | The failure                                           |
| ----------------------- | ----------------------------------------------------- |
| `crashloop`             | A service that cannot reach its database              |
| `missing-env`           | A required environment variable is not set            |
| `oomkilled`             | A container that runs out of memory                   |
| `bad-image-tag`         | An image tag that does not exist                      |
| `readiness-probe`       | A readiness probe that never passes                   |
| `service-no-endpoints`  | A Service whose selector matches no pods              |
| `pvc-pending`           | A volume claim with a storage class that is not there |
| `missing-configmap-key` | A ConfigMap without the key a container needs         |
| `unschedulable`         | A pod that asks for more CPU than any node has        |
| `release-500s`          | A new release that answers with errors                |

Every scenario uses only Kubernetes data (pods, logs, events, deployments, replica sets,
services), so the suite needs no Prometheus.

## Running the suite

Needs Docker, kind, and the pinned MCP servers (`pnpm mcp:fetch`). The model key comes from
the environment, as `kodra-agent run` reads it.

```sh
pnpm eval --provider ollama --model <id> --set baseUrl=http://127.0.0.1:11434
ANTHROPIC_API_KEY=... pnpm eval --provider anthropic --model <id>
pnpm eval --provider bedrock --model <id> --set region=eu-central-1 --only oomkilled,crashloop
```

- `--set key=value`: a model setting (`baseUrl`, `region`, `endpoint`, `deployment`).
- `--only a,b`: some scenarios, in that order.
- `--keep`: keep the cluster `kodra-agent-eval` for the next run (else it is deleted).
- `--out <dir>`: where reports go (default `evals/reports`).

The agent runs exactly as in production: the real runtime, policy engine, and redactor, the
pinned Kubernetes MCP server, and a service account bound only by the Kubernetes bundle's own
read-only `rbac.yaml`. Investigations are read-only, so write tools are not even offered.

Each run writes `evals/reports/<date>-<provider>-<model>.json` and `.md`: per scenario, whether
the root cause was right, the facts found, any must-not, tool calls, tokens, cost, and time,
plus the answer itself. The report states the date, the exact model id, the provider, and the
commit. Cost uses the model manifest's prices; a model without prices (like a local Ollama
model) shows cost as unknown.

**Checks are deterministic.** No model grades another. A pattern list can be too strict or
too loose for a given answer: read the answers in the report before drawing conclusions, and
widen a pattern in the scenario when a right answer was missed.

**Real numbers only.** A figure about the agent's results in the README or the docs cites a
committed report, with its date and model id.

## Reports so far

| Date       | Model                         | Passed  | Right root cause | Report                                                                               |
| ---------- | ----------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------ |
| 2026-10-25 | `flint:latest` through Ollama | 9 of 10 | 10 of 10         | [2026-10-25-ollama-flint-latest](../evals/reports/2026-10-25-ollama-flint-latest.md) |

The one failure, `bad-image-tag`, named the missing tag correctly but also suggested `busybox:latest` as a fix, which the scenario does not allow.

## The demo

`kodra-agent demo` runs three of the scenarios (`missing-env`, `oomkilled`, `bad-image-tag`)
on a throwaway cluster named `kodra-agent-demo` and prints what the agent found. It is a
one-shot command with the Docker socket, never part of the always-on agent: inside the
agent's own pod it refuses to run.

```sh
# Without a bundle: the image, the Docker socket, and your model key.
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -e ANTHROPIC_API_KEY ghcr.io/kodra-io/kodra-agent:<version> \
  demo --provider anthropic --model <id>

# In a Compose bundle: the model in kodra-agent.yaml, the key in .env.
docker compose run --rm kodra-demo

# Remove the cluster when you are done.
docker compose run --rm kodra-demo demo --cleanup
```

On Linux, add `--group-add $(stat -c %g /var/run/docker.sock)` to `docker run` so the image's
non-root user can use the socket (the bundle sets `KODRA_DOCKER_GID`). The image carries kind
`v0.33.0`, pinned by SHA-256 (`apps/agent/src/evals/kind-pin.ts`). The cluster stays after the
demo so you can look around; `demo --cleanup` deletes it.
