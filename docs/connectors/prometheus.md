# Prometheus connector

**Server:** [`pab1it0/prometheus-mcp-server`](https://github.com/pab1it0/prometheus-mcp-server) 1.6.2 (PyPI `prometheus-mcp-server`)
**Decided:** 2026-10-02, for M4

## Why this server

| Check       | Finding                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| License     | MIT                                                                                                  |
| Maintenance | Active: commits weekly, 1.6.2 released 2026-08-03, about 500 stars                                   |
| Runtime     | Python. Run with `uvx` at a pinned version (M7 installs it into the image from a locked environment) |
| Controls    | Read-only by design: all six tools query the Prometheus HTTP API                                     |
| Telemetry   | None found in the docs                                                                               |

Considered: Grafana's server covers Prometheus only through a Grafana datasource, but this connector talks to Prometheus directly, without Grafana. Writing our own was not justified while a maintained, read-only server exists (SPEC section 6).

## How it runs

```
uvx --from prometheus-mcp-server==1.6.2 prometheus-mcp-server
```

Environment: `PROMETHEUS_URL` (from config), `PROMETHEUS_TOKEN` (optional secret), `PROMETHEUS_DISABLE_LINKS=True` (saves tokens), `PROMETHEUS_MCP_SERVER_TRANSPORT=stdio`.

**Important:** this server loads a `.env` file from its working directory. The connector host starts every server in its own empty, private temporary folder, so it can never read the bundle's `.env` with other connectors' secrets.

## Supply chain note

`uvx` pins the server version but resolves its Python dependencies at start. M7 must install it from a lock file (`uv` with hashes) in the image, so production never resolves dependencies at runtime.

## Tool classification

All six tools are **read**: `execute_query`, `execute_range_query`, `get_metric_metadata`, `get_targets`, `health_check`, `list_metrics`.

The server has no Alertmanager tools. The M5 monitoring loop polls Alertmanager directly.
