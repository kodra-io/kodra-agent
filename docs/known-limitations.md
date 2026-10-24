# Known limitations

What Kodra AI Agent does not protect against or does not do yet. Each item says what you can
do about it. The threat model is in [docs/security/threat-model.md](security/threat-model.md).

## Security

- **Approvals are only as good as the approvers.** Prompt injection in a log, issue, or file
  cannot run a change by itself, but it can make the model propose a convincing one. Read the
  arguments and the diff before you approve, and use two approvers for production (the strict
  profile does).
- **Anyone who can change the agent's host can change the agent.** Its config, environment,
  image, and volume are trusted. Someone with `docker exec`, `kubectl exec`, or write access to
  the bundle folder can read its secrets or change its policy. Limit who has that access.
- **The audit chain shows tampering, it does not prevent it.** Someone who can write the log
  can rewrite the whole chain from the start. Ship records off the machine with
  `spec.audit.stdout`, or note the head hash from the console now and then.
- **Two processes writing the same audit log at the same moment** (for example `doctor` while
  `run` is busy) can write two records with the same number. `audit verify` then reports a
  break. The records themselves are kept.
- **The model provider sees what the agent reads**, after secrets are redacted and the
  detectors in `spec.dataProtection` mask customer data. Data that no detector or pattern
  matches is sent as is. Add `patterns` for your own identifiers, or pin an environment to a
  local model.
- **Metric reads are not placed in an environment.** A Prometheus or Grafana query does not
  name a namespace the way a Kubernetes call does, so it does not pin the conversation to an
  environment's model. Use a separate Prometheus connector, or none, for pinned environments.
- **Masked values cannot be revealed.** An approver sees `[email:7f3a]`, not the address.
- **The Docker socket is close to root on that machine.** With Docker build access on
  Compose, `kodra-builder` mounts it while a build runs. Use a machine meant for builds.
- **Any process in the agent's pod can read its ServiceAccount token.** With write access the
  token can only scale deployments in the agent's namespaces (get and update on
  `deployments/scale`, nothing else), so it cannot change a pod template, but it can scale
  outside an approval. An admission policy that limits the token further is on the roadmap
  (M9b). Keep write access off where you do not need it.
- **The console has one password account.** `admin` signs in with the password `kodra-agent
init` asked for; there is no default, and the console does not start without one. Everyone
  else uses sign-in tokens. A forgotten password is reset with `kodra-agent init
--reset-console-password`. Keep the console off public networks.
- **Server-side tool filters are best effort.** For example, GitLab's deny regex silently
  stops working past 200 characters. The agent's own classification and guards are the real
  gate, and they do not depend on the servers.

## Networks

- **The agent's own Kubernetes client does not use `spec.network.proxy`.** The Kubernetes MCP
  server does, and in-cluster API servers are usually reached directly. If your API server is
  only reachable through the proxy, the console's settings changes on Kubernetes will fail.

## Observability

- **Metrics start from zero when the agent restarts**, like any Prometheus counter.
  Approvals that were waiting are lost on a restart too, so the approval gauges start empty.
- **Traces are not linked to your services' traces.** Spans start a new trace for each turn.

## Configuration

- **Approval rules, freezes, the proxy, masking, and named models are edited in
  `kodra-agent.yaml`**, not in the configurator or the console.
