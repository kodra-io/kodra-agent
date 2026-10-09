# Web console

`kodra-agent run` serves a small read-only web console next to Slack and the terminal. It
shows what the agent can do and what it did. It cannot change anything: approvals still
happen in Slack or the terminal.

| Page           | What it shows                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Model, version, where the agent runs, uptime, Slack and alert monitoring, connectors                                                           |
| Connectors     | Each connector's access, the tools the model can use with their risk and limits, and for an unavailable connector the reason and how to fix it |
| Activity       | The audit log, filtered by event, decision, connector, and text. Secrets are already removed                                                   |
| Investigations | Alerts the agent looked into, read-only, and its findings                                                                                      |
| Usage          | Model calls and tokens per day and per question, with an estimated cost                                                                        |
| Approvals      | Each approval request, who asked, and what an approver decided                                                                                 |

The console is on by default. Turn it off with `spec.console.enabled: false`, or with the
switch on the configurator's Review step.

## Access

The console listens on port 8081 (`spec.console.port`) and is meant to be reached only from
the machine running the agent:

- **Docker Compose.** The bundle publishes the port on `127.0.0.1` only. Open
  `http://localhost:8081`.
- **Kubernetes.** The chart makes a `ClusterIP` service, `<release>-console`. Run
  `kubectl port-forward svc/<release>-console 8081:8081` and open `http://localhost:8081`.
  The chart's notes print the exact command.

Do not put the console behind a public load balancer or ingress. It has no user accounts,
only one shared token.

## Signing in

`kodra-agent init` creates the sign-in token, `KODRA_CONSOLE_TOKEN`:

- **Docker Compose.** It goes in the bundle's `.env` once and is kept on later runs.
- **Kubernetes.** It goes in the agent's Secret. The Secret is rewritten as a whole, so each
  `init` run makes a new token. Read it with
  `kubectl get secret <name> -o jsonpath='{.data.KODRA_CONSOLE_TOKEN}' | base64 -d`.

If the console is on and the token is missing, `run` prints an error and starts without the
console.

How sign-in is protected:

- The token is compared in constant time and registered with the redactor, so it never
  reaches output or the audit log.
- A correct token gives an `HttpOnly`, `SameSite=Strict` session cookie for 12 hours.
- At most 10 failed sign-ins per minute per address.
- Sign-in and sign-out check the `Origin` header. Every other API route is `GET` only.
- The pages are served with a strict CSP (`connect-src 'self'`, `frame-ancestors 'none'`)
  and load nothing from other sites.

## Estimated cost

Each model call in the audit log records its token usage. The Usage page multiplies it by a
price table: Anthropic list prices, dated, in `packages/connectors/src/models.ts`. Other
providers have no table. For those, or to use your own prices, set:

```yaml
spec:
  console:
    pricing:
      inputPerMTok: 3 # dollars per million tokens
      outputPerMTok: 15
      cacheReadPerMTok: 0.3 # optional
      cacheWritePerMTok: 3.75 # optional
```

The cost is an estimate. Your provider's bill is the real number. Model calls made before
v0.1.3 have no recorded usage and count as zero.

## Development

```sh
pnpm --filter @kodra-agent/console dev        # http://localhost:5175 (the e2e tests mock the API)
pnpm --filter @kodra-agent/console build      # apps/console/dist, served by kodra-agent run
pnpm --filter @kodra-agent/console test:e2e   # Playwright against a mocked API
```

The API lives in `apps/agent/src/console` (`server.ts`, `routes.ts`, `data.ts`). The image
builds the app and copies `apps/console/dist` next to the agent.
