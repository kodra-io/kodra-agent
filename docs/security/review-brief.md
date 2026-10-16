# Security review brief

A starting point for a security team reviewing Kodra AI Agent before running it. It takes
about an hour to read with the linked pages.

## What it is

A self-hosted AI DevOps agent. You run one container (Docker Compose or a Helm chart) with
your own model key. It reads your clusters, repos, and monitoring through pinned MCP servers,
answers questions in Slack and a web console, investigates alerts, and proposes changes that a
named person must approve. Kodra.io runs no backend and receives nothing.

## Where to look

| Question                                     | Read                                                               |
| -------------------------------------------- | ------------------------------------------------------------------ |
| What data goes where?                        | [Data flow](data-flow.md)                                          |
| What can go wrong, and what stops it?        | [Threat model](threat-model.md)                                    |
| What does it not protect against?            | [Known limitations](../known-limitations.md)                       |
| Who approves what, and when?                 | [Approvals](../approvals.md)                                       |
| How is customer data kept from the model?    | [Data protection](../data-protection.md)                           |
| How does it work behind a proxy, or offline? | [Networks](../network.md), [air-gapped installs](../air-gapped.md) |
| How do we watch it and check its audit log?  | [Observability](../observability.md)                               |
| Why each MCP server was chosen               | [Connector decisions](../connectors/)                              |
| How to report a vulnerability                | [SECURITY.md](../../SECURITY.md)                                   |

## The controls in one list

1. **Secrets stay in your environment.** Never in the configurator, the model, Slack, the
   console, logs, metrics, traces, or the audit log. Canary tests fail the build on a leak.
2. **Read-only by default.** Writes need an approval from a named Slack user or console
   account; destructive tools are blocked; tools without a risk classification are blocked.
3. **Tool output is untrusted.** It is wrapped and escaped, and alert investigations can only
   read.
4. **Scoped by guards** that the agent checks itself: configured repos and namespaces, never
   a default branch, never the agent's own objects.
5. **Change control:** approvals per environment, two approvers, change references, freezes
   with break-glass, and a pause switch.
6. **Customer data masked** before the model; environments can be pinned to their own model.
7. **Tamper-evident audit log** with a hash chain, `kodra-agent audit verify`, and records on
   stdout for your log collector.
8. **Locked-down runtime:** non-root, read-only root filesystem, no capabilities, an egress
   NetworkPolicy on Kubernetes, and no Docker socket on the always-on container.
9. **Signed releases:** cosign-signed image and chart, SBOM, provenance, checksums; every
   dependency, base image, MCP server, and CI action pinned.
10. **No telemetry.** Metrics and traces go only where you point them; traces are off by
    default.

## Suggested checks

- Run `kodra-agent doctor` and read every row.
- Verify the image signature and SBOM ([README](../../README.md#verify-a-release)).
- Read the bundle's `kodra-agent.yaml`, `rbac.yaml`, and `values.yaml` before installing.
- Ask the agent to make a change and confirm it waits for approval; ask it to delete
  something and confirm it refuses.
- Put a made-up token in a log line the agent reads, then search the audit log, Slack, and
  the console for it.
- Edit one audit record and run `kodra-agent audit verify`.
