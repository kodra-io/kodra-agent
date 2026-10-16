# Observability

How to watch the agent itself: a tamper-evident audit log, Prometheus metrics, a Grafana
dashboard, alert rules, and optional OpenTelemetry traces (PLAN-v0.2 M14). None of these
carry content: no prompts, arguments, answers, or tool output, only ids, counts, durations,
and labels from fixed lists. Nothing is sent anywhere unless you point it there.

## The audit log

Every record is a JSON line in `spec.audit.path` (`/var/lib/kodra-agent/audit.jsonl`), with
secrets redacted and customer data masked. Each record has a `seq` number and `prev`, the
SHA-256 of the line before it, so editing, deleting, or reordering a record breaks the chain.
Rotation (10 MB, five files kept) carries the chain into the next file.

```sh
kodra-agent audit verify          # says where the chain first breaks
kodra-agent audit verify --json
docker compose run --rm kodra-agent audit verify    # Compose
kubectl -n kodra-agent exec deploy/<name>-kodra-agent -- node /app/apps/agent/src/bin.ts audit verify
```

`kodra-agent doctor` runs the same check (the `audit chain` row). The console's Overview shows
the newest record's number and hash. Note it somewhere else now and then: someone who can
write the log could rewrite the whole chain, but not one that matches a hash you kept.

Records written before 0.3.0 have no chain. `audit verify` counts them and checks the rest.

### Records on stdout

```yaml
spec:
  audit:
    stdout: true
```

`kodra-agent run` also writes each record, already redacted, as one JSON line to stdout, for
a log collector (Fluent Bit, Vector, the Loki or CloudWatch agents). A copy outside the
agent's volume is the strongest check against a rewritten log.

## Metrics

```yaml
spec:
  metrics:
    enabled: true # the default
    port: 9464
```

`GET /metrics` on port 9464, in the Prometheus text format. The port is not published by the
Compose bundle; the chart adds a ClusterIP Service, `<release>-kodra-agent-metrics`.

| Metric                                                     | Type    | Labels                          |
| ---------------------------------------------------------- | ------- | ------------------------------- |
| `kodra_agent_info`                                         | gauge   | `version`                       |
| `kodra_agent_tool_calls_total`                             | counter | `connector`, `risk`, `decision` |
| `kodra_agent_approvals_pending`                            | gauge   |                                 |
| `kodra_agent_approval_oldest_seconds`                      | gauge   |                                 |
| `kodra_agent_approval_wait_seconds_sum`, `_count`          | counter | `decision`                      |
| `kodra_agent_investigations_total`                         | counter |                                 |
| `kodra_agent_investigation_seconds_sum`                    | counter |                                 |
| `kodra_agent_model_tokens_total`                           | counter | `model`, `kind`                 |
| `kodra_agent_model_cost_usd_total`                         | counter | `model`                         |
| `kodra_agent_connector_up`                                 | gauge   | `connector`                     |
| `kodra_agent_errors_total`                                 | counter | `source`                        |
| `kodra_agent_budget_remaining_usd`, `_ratio` (with budget) | gauge   |                                 |

Label values come only from fixed lists: connector ids, risks, decisions, and the model labels
in your config. Anything else becomes `other`. Counters start at zero when the agent starts.

### On Kubernetes

```yaml
metrics:
  serviceMonitor:
    enabled: true
    labels: { release: kube-prometheus-stack } # what your Prometheus selects
  prometheusRule:
    enabled: true
```

The rules are in `charts/kodra-agent/files/alerts.yaml`, also usable as a plain Prometheus
rules file:

| Alert                     | When                                        |
| ------------------------- | ------------------------------------------- |
| `KodraAgentConnectorDown` | a connector has not started for 10 minutes  |
| `KodraAgentErrors`        | more than 3 errors in 15 minutes            |
| `KodraAgentApprovalStuck` | a change has waited over 15 minutes         |
| `KodraAgentBudgetLow`     | less than 10% of the monthly budget is left |

The package test runs `promtool check rules` and a `promtool test rules` unit test on them.

### Grafana

Import `dashboards/kodra-agent.json` (Dashboards, New, Import) and pick your Prometheus data
source. A test fails if the dashboard or the alert rules use a metric the agent does not
expose, or if a metric is used by neither.

## Traces

```yaml
spec:
  tracing:
    enabled: true
    endpoint: http://otel-collector.monitoring:4318/v1/traces
```

Off by default. When on, the agent sends OpenTelemetry spans over OTLP/HTTP to your collector:

- `kodra.turn` for each question or alert investigation: the task kind (`alert`, `slack`,
  `console`, `chat`), the outcome, and token counts.
- `kodra.model` for each model step, a child of the turn: the model label, token counts, and
  the finish reason.
- `kodra.tool` for each tool call, a child of the turn: connector, tool, risk, and decision.

Spans are sent in batches every few seconds, and the rest when the agent stops. The endpoint follows `spec.network` like any
other connection: add the collector to `noProxy` when it is inside your network.
