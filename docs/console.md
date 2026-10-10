# Web console

`kodra-agent run` serves a web console next to Slack and the terminal. You can ask the agent
questions there, watch what it does, and approve or deny the changes it asks for. The policy
is the same everywhere: reads run, writes wait for an approver, destructive actions are
blocked unless you allowed them.

| Page           | What it shows                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Model, version, where the agent runs, uptime, Slack and alert monitoring, connectors                                                           |
| Chat           | Conversations with the agent: each tool call live, with its risk and state, approval requests inline, and the answer with its token usage      |
| Connectors     | Each connector's access, the tools the model can use with their risk and limits, and for an unavailable connector the reason and how to fix it |
| Activity       | The audit log, filtered by event, decision, connector, and text. Secrets are already removed                                                   |
| Investigations | Alerts the agent looked into, read-only, and its findings                                                                                      |
| Usage          | Model calls and tokens per day and per question, with an estimated cost                                                                        |
| Approvals      | Requests waiting for a decision (from the console or Slack), then each request and what an approver decided                                    |

The console is on by default. Turn it off with `spec.console.enabled: false`, and only the
chat with `spec.console.chat: false`. The configurator's Review step has a switch for each.

## Access

The console listens on port 8081 (`spec.console.port`) and is meant to be reached only from
the machine running the agent:

- **Docker Compose.** The bundle publishes the port on `127.0.0.1` only. Open
  `http://localhost:8081`.
- **Kubernetes.** The chart makes a `ClusterIP` service, `<release>-console`. Run
  `kubectl port-forward svc/<release>-console 8081:8081` and open `http://localhost:8081`.
  The chart's notes print the exact command.

Do not put the console behind a public load balancer or ingress. It signs people in with
tokens, not user accounts.

## Who can do what

There are two kinds of sign-in token:

| Token                                  | Who                                        | Can                                      |
| -------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `KODRA_CONSOLE_TOKEN`                  | The team (signs in as `console`)           | View every page, chat. Cannot approve.   |
| `KODRA_CONSOLE_TOKEN_<NAME>`, one each | A console approver, such as `console:omar` | View, chat, and approve or deny changes. |

Console approvers are listed with the Slack approvers:

```yaml
spec:
  policy:
    approvals:
      approvers: ['@omar', 'console:omar', 'console:on-call']
```

`console:on-call` signs in with `KODRA_CONSOLE_TOKEN_ON_CALL`. The audit log records the
approver's name, for example `console:omar`, so give each person their own entry rather than
sharing one.

A change the agent asks for goes to every place that can answer it: the console, and Slack if
it is set up. The first decision wins, and the other place shows who decided. A request from
a Slack thread can be approved in the console, and the other way round. If nobody can approve
(no Slack and no console approvers), the request expires and nothing runs.

Approving takes two clicks: **Approve**, then **Yes, run it**. A denial can carry a reason;
the agent sees it and the audit log keeps it.

## Signing in

`kodra-agent init` creates the tokens:

- **Docker Compose.** They go in the bundle's `.env` once and are kept on later runs. Adding
  a console approver later and running `init` again adds only their token.
- **Kubernetes.** They go in the agent's Secret. The Secret is rewritten as a whole, so each
  `init` run makes new tokens. `init` prints the command to read each one, for example
  `kubectl get secret <name> -o jsonpath='{.data.KODRA_CONSOLE_TOKEN_OMAR}' | base64 -d`.

If the console is on and `KODRA_CONSOLE_TOKEN` is missing, `run` prints an error and starts
without the console. A console approver without a token cannot sign in, and `run` says so.

How the console is protected:

- Tokens are compared in constant time, against every account, and registered with the
  redactor, so they never reach output, the model, or the audit log.
- A correct token gives an `HttpOnly`, `SameSite=Strict` session cookie for 12 hours.
  Signing out ends the session and its live streams.
- At most 10 failed sign-ins per minute per address.
- Every `POST` checks the `Origin` header. Chat and approval requests also need the session,
  a JSON body of at most 16 KB, and the `x-kodra-console: 1` header, which a cross-site form
  cannot send.
- Messages are at most 8,000 characters, 10 per minute per name (everyone on the shared token counts as one), and are redacted before
  the model sees them. Text from the browser is untrusted input: it never changes the policy.
- At most 2 questions run at once across the console, to protect your model budget. More wait
  their turn.
- Live events carry tool names, risks, redacted arguments, and states, never tool output.
- The pages are served with a strict CSP (`connect-src 'self'`, `frame-ancestors 'none'`)
  and load nothing from other sites.

Conversations live in memory, up to 20, and are gone when the agent restarts. The audit log
keeps the record of every question, tool call, and decision.

## Settings

**Settings** shows what the agent can reach, who approves its changes, and its limits.
A console approver can change them; everyone else sees them read-only.

- **Connectors:**
  - turn each one on or off;
  - choose its access;
  - edit its settings (projects, namespaces, addresses);
  - **Test connection**: runs the same checks as `doctor`. Anyone signed in can run it.
- **Approvals and policy:** approvers, how long a request stays open, and whether destructive
  actions are blocked.
- **Model and limits:** the model name, the limits for each question, and the monthly budget.
- **Console:** chat on or off. The console cannot turn itself off, and the last console
  approver cannot be removed here, so nobody locks themselves out.

How a change is saved:

1. Your edits go onto `kodra-agent.yaml` itself, so its comments and layout stay. They are
   checked with the same rules as `init` and `doctor`.
2. **Review changes** shows the diff, and calls out any access the change adds: a connector
   turned on, write access, more projects or namespaces, a new approver, destructive actions
   allowed, chat turned on.
3. **Save and restart**, then a second confirmation. The previous file is kept as
   `kodra-agent.yaml.previous`, and the change is audited (event `settings`, with your name).
4. The agent restarts to apply it, in about 15 seconds; Docker Compose starts it again
   (`restart: unless-stopped`). You stay signed in: sessions are signed with each person's
   token, so a restart does not end them.
5. **Undo last change** puts the previous file back the same way.

Secrets are write-only. **Replace** checks a new value with the connector's own check first,
and only then writes it to `.env`; the value is never shown again, logged, or sent anywhere.
Secrets that are files (a kubeconfig) live on a read-only mount: put the new file on the host
and restart.

On Kubernetes the settings are read-only for now: change `values.yaml` and run
`helm upgrade`.

### People and tokens

Console approvers get a **People and tokens** tab in Settings. Nobody else sees it, and its
API answers 403 to anyone else.

- **Add a console approver** (`console:<name>`). The agent creates their token, writes it to
  `.env`, adds them to the approvers, and restarts.
- **Rotate token** for the shared sign-in or any console approver. The old token stops
  working when the agent comes back, and so do the sessions made with it. Rotating your own
  token signs you out: sign in with the new one.
- **Remove** a console approver. Their token is deleted from `.env`. The last console
  approver cannot be removed.
- **Signed in now** lists the browsers that used the console since the agent started, with
  when they signed in and were last seen. **Sign out** ends a session and its live streams
  at once. Sign-outs are kept in `console-sessions.json` next to the audit log, so a restart
  does not bring them back.

A new token is shown once, in the browser of the approver who asked, and stays on screen
while the agent restarts. Copy it and send it privately. It is registered with the redactor
and is never audited, logged, or shown again; the audit log only records who added, rotated,
or removed whom. On Kubernetes the tokens live in the agent's Secret, so this tab is
read-only there.

## Pausing changes

**Pause all changes** (on Overview, and **Pause agent** in the sidebar) stops the agent from
changing anything, right away:

- Every change is refused when it would run, even one an approver said yes to before the
  pause. Proposed changes are refused too.
- Reads, chat, and alert investigations keep working.
- Anyone signed in can pause. Only a console approver can resume.
- Both are in the audit log (event `control`, with who did it) and posted to Slack, or the
  terminal without Slack. A banner on every console page says who paused, and when.
- The state is saved next to the audit log (`control.json`), so a restart keeps it.

## Monthly budget

Set `spec.limits.monthlyBudgetUsd` to cap the estimated spend per calendar month (UTC):

```yaml
spec:
  limits:
    monthlyBudgetUsd: 40
```

Overview shows the month's spend against it. When it is used up, new questions in the
console, Slack, and `kodra-agent chat` are refused, and the refusal is audited. Alert
investigations keep running, so an incident is never left unexamined. The spend is the same
estimate as the Usage page (below); without a known price there is no estimate and the budget
does not apply.

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

The API lives in `apps/agent/src/console`: `server.ts` (sign-in, routes, event streams),
`routes.ts`, `data.ts` (read views), `chat.ts` (conversations), and `approvals.ts` (console
approvals). The image builds the app and copies `apps/console/dist` next to the agent.
