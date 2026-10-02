# Grafana connector (includes Loki and Prometheus through Grafana)

**Server:** [`grafana/mcp-grafana`](https://github.com/grafana/mcp-grafana) v2.0.0
**Decided:** 2026-10-02, for M4

## Why this server

| Check       | Finding                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| License     | Apache-2.0                                                                                      |
| Maintenance | Official Grafana Labs project, releases several times a week, about 3.5k stars                  |
| Runtime     | A single Go binary per platform                                                                 |
| Controls    | `--disable-write`, `--enabled-tools <categories>`, per-category `--disable-*` flags             |
| Telemetry   | **On by default since v2.0.0** (anonymous usage reports to Grafana Labs). Turned off; see below |

## Version choice: 2.0.0 over 1.6.3

2.0.0 (2026-10-01) splits the alerting tools into read and write tools (`alerting_rules_read` / `alerting_rules_write`, `alerting_silences_read` / `alerting_silences_write`). With 1.6.3 a single `alerting_manage_rules` tool does both, so read-only access would have had to block alert reads entirely. The other 2.0 changes (MCP Go SDK, removed Sift tools, SSE header handling) do not affect a stdio server.

## Pinning

Release archives for all four platforms, pinned by SHA-256. All four hashes match Grafana's published `mcp-grafana_2.0.0_checksums.txt`.

## How it runs

```
mcp-grafana --usage-stats=disabled --disable-write \
  --enabled-tools search,datasource,prometheus,loki,alerting,dashboard
```

Environment: `GRAFANA_URL` (from config), `GRAFANA_SERVICE_ACCOUNT_TOKEN` (secret), and `GRAFANA_USAGE_STATS=disabled` plus `DO_NOT_TRACK=1`, so usage reporting stays off even if a flag changes in a later version (golden rule 7).

Not enabled: `docs` (fetches grafana.com over the internet), `admin`, `incident`, `oncall`, `annotations`, `snapshot`, `rendering`, and the datasource-specific categories.

## Tool classification

With the flags above the server exposes 25 tools, all **read**: alerting reads, dashboard reads, datasource reads, Loki queries, Prometheus queries, and search.

The enabled categories also contain six write tools that `--disable-write` hides. They are classified so nothing is unclassified if a flag ever changes: `alerting_rules_write`, `alerting_silences_write`, `alerting_routing_write`, and `update_dashboard` are **write**; `create_datasource` and `update_datasource` are **destructive** (they can point Grafana at a different backend). The connector only offers read-only access, so all six are blocked by policy anyway.
