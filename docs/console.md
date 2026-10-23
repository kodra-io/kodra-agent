# Web console

`kodra-agent run` serves a web console next to Slack and the terminal. You can ask the agent
questions there, watch what it does, and approve or deny the changes it asks for. The policy
is the same everywhere: reads run, writes wait for an approver, destructive actions are
blocked unless you allowed them.

| Page           | What it shows                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | The operations center (below), then model, version, where the agent runs, uptime, Slack and alert monitoring, connectors                       |
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

Do not put the console behind a public load balancer or ingress. It has one password
account (`admin`) and sign-in tokens, not full user accounts yet.

## Who can do what

**The admin.** Sign in with the username `admin` and the password `admin`. The console then
asks for a new password (at least 12 characters) and allows nothing else until it is set.
The admin signs in as `console:admin`: they can view every page and chat, and approve where
`console:admin` is listed as an approver. Only a scrypt hash of the password is kept, in
`console-users.json` next to the audit log (owner-only). Changing it signs out the admin's
other sessions and is audited (`settings`, never the password). To reset a forgotten
password, stop the agent, delete that file, and start it again: `admin`/`admin` works once
more. A broken file stops the agent instead of falling back to the default.

There are also two kinds of sign-in token (**Sign in with a token instead**):

| Token                                  | Who                                        | Can                                      |
| -------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `KODRA_CONSOLE_TOKEN`                  | The team (signs in as `console`)           | View every page, chat. Cannot approve.   |
| `KODRA_CONSOLE_TOKEN_<NAME>`, one each | A console approver, such as `console:omar` | View, chat, and approve or deny changes. |

Console approvers are listed with the Slack approvers:

```yaml
spec:
  policy:
    approvals:
      approvers: ['U0123ABCD', 'console:omar', 'console:on-call']
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

The console starts without `KODRA_CONSOLE_TOKEN`: the admin can still sign in. A console
approver without a token cannot sign in, and `run` says so (`console:admin` needs no token).

How the console is protected:

- Tokens are compared in constant time, against every account, and registered with the
  redactor, so they never reach output, the model, or the audit log. Wrong passwords and
  wrong tokens share the same limit of 10 a minute.
- A correct token or password gives an `HttpOnly`, `SameSite=Strict` session cookie for 12 hours.
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

## Dashboard

The **Dashboard** page shows what the agent can see in your tools right now:

| Connector      | Cards                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes     | Pods by state (running, failing, pending) with restarts; deployments ready against desired; recent warning events. Per listed namespace. |
| Databases      | Each listed database: state, version, connections in use, a replica's lag, and why it is not ok.                                         |
| GitLab CI      | The latest 20 pipelines per project: passed, failed, running, with links.                                                                |
| GitHub Actions | The latest 20 workflow runs per repo: passed, failed, running, with links.                                                               |

How it works:

- Each card is a read tool listed in the connector's manifest (`dashboard`), called without
  the model. It goes through the same policy check as the agent's calls (classification and
  guards, such as the namespace list), and the output is redacted before it is read. A
  manifest test refuses a card on anything but a read tool.
- Only parsed fields reach the page, and they are shown as text. Links are kept only when
  they are `http(s)` links.
- The agent refreshes at most once a minute, whoever is looking; the page asks again every
  minute while it is open. A target that fails shows why (for example, a token without
  access).
- Dashboard reads are not audited: nothing changes and no model is involved. The agent's own
  tool calls are audited as before.

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
- **Model and limits:** the model, the limits for each question, and the monthly budget. The
  model is picked from the models the agent's key can use (the provider's own model list;
  Bedrock offers the known models), with list prices and this month's questions priced at
  each. **Test** asks the model one tiny question (5 output tokens at most); saving a new
  model does the same first and refuses one that does not answer, so a typo never stops the
  agent. **Another model** takes any name.
- **Change provider** (in Model and limits) switches to another model provider: Anthropic,
  OpenAI, Azure OpenAI, Bedrock, or Ollama, drawn from their manifests. Fill the provider's
  settings and paste its key (or leave it empty when the key is already in `.env`), then
  **Check**: the provider's own check runs with that key and its models are listed with
  prices. **Switch** asks the chosen model one tiny question with the new key, then writes
  the key to `.env` (or the agent's Secret), keeps the old provider's key, rewrites
  `spec.model` with a reference to the key (never the value), and restarts. **Undo last
  change** puts the old provider back. Where the model sends data is a policy change: it is
  announced on `team`, and on `strict` it waits for a second approver, with the key written
  only once it is approved.
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

Secrets are write-only. **Add** or **Replace** checks a new value with the connector's own
check first, and only then saves it; the value is never shown again, logged, or sent anywhere.

### Setting up a connector from the console

Everything a connector needs can be set here, without editing files on the host:

- A connector that still needs a secret says so at the top of its page (**Still needed**).
- Each secret, and settings like a bastion's host key, has **How to get this**: the steps from
  the connector's manifest, with this agent's own settings filled in (its namespaces, repos,
  the database's host and user). Commands come for **Linux**, **macOS**, and **Windows**
  (PowerShell), with a **Copy** button. The console guesses your system and remembers the one
  you pick, in this browser only. Commands only produce a value or a file for you to paste:
  nothing runs them for you. A setting that is not plainly safe to paste into a shell (or is
  not set yet) stays a visible `<placeholder>` for you to fill in.
- Files (a kubeconfig, an SSH private key for a database tunnel) are pasted or uploaded
  (48 KiB at most). Their shape is checked first, in plain words: a kubeconfig needs a
  current context, and an SSH key must not have a passphrase. Then the connector's own check
  runs with the new file, and only then is it saved: on Docker Compose as an owner-only file
  in the bundle folder's `secrets/` (like `secrets/kubernetes-kubeconfig`), on Kubernetes in
  the agent's Secret. The config is pointed at it in the same step (audited, kept for Undo),
  and the agent restarts.
- The steps for a kubeconfig make a service account with a read-only Role in each of the
  connector's namespaces and a kubeconfig with its token. That works on any cluster, EKS
  included, without cloud keys. An EKS kubeconfig that runs `aws eks get-token` works too:
  set the Kubernetes connector's two optional AWS keys (tested once the kubeconfig and both
  keys are there), or keep `AWS_*` in the agent's environment as before.
- Settings, Network, Trusted certificates takes a PEM file of extra CA certificates (an
  internal CA, a TLS-inspecting proxy, or Amazon RDS's `global-bundle.pem` for a database with
  Encryption set to verify). Certificates only: a file with a private key is refused. On
  Docker Compose it is saved as `ca/console-ca-bundle.pem`, `spec.network.caBundleFile`
  points at it (audited, kept for Undo), and the agent restarts. On Kubernetes it comes from
  the chart's `caBundle` values instead.

### On Kubernetes

With the chart's `console.editSettings` (on by default), the same page works on Kubernetes:

- The config is saved in a settings ConfigMap of the agent's own, `<release>-settings`, next to
  the one Helm manages, with the previous copy (`kodra-agent.yaml.previous`) for Undo and the
  hash of the Helm config it was made from. Secrets and sign-in tokens are saved in its
  Secret (`existingSecret`).
- To apply a change, the agent restarts its own Deployment, as `kubectl rollout restart`
  does. The new pod mounts the settings ConfigMap and reads the Secret into its environment.
- The chart's Role lets the agent get and patch exactly three objects, by name: the settings
  ConfigMap, its Secret, and its Deployment. Not Helm's ConfigMap, nothing else in the
  namespace, and no list, create, or delete. It uses the pod's own service account, never a
  kubeconfig the connectors use, so `serviceAccount.automountToken` must stay on.
- Helm creates the settings ConfigMap empty and never sets its data, so a `helm upgrade`
  never conflicts with the console's changes (with Helm 4's server-side apply, a field the
  agent changed in Helm's own ConfigMap would make every upgrade fail).
- `helm upgrade` with the same config keeps what was saved in the console. An upgrade with a
  changed config wins: the agent starts from it and sets the console's copy aside, and says
  so in its log. To keep the console's changes, start from its copy, as the chart notes show:
  `kubectl get configmap <release>-settings -o jsonpath='{.data.kodra-agent\.yaml}' > kodra-agent.yaml`.

Set `console.editSettings: false` to keep settings read-only: then change `values.yaml` and
run `helm upgrade`. Without `existingSecret`, the config is editable but secrets are not.

### People and tokens

Console approvers get a **People and tokens** tab in Settings. Nobody else sees it, and its
API answers 403 to anyone else.

- **Add a console approver** (`console:<name>`). The agent creates their token, writes it to
  `.env` (or the Secret, on Kubernetes), adds them to the approvers, and restarts.
- **Rotate token** for the shared sign-in or any console approver. The old token stops
  working when the agent comes back, and so do the sessions made with it. Rotating your own
  token signs you out: sign in with the new one.
- **Remove** a console approver. Their token is deleted from `.env` (or the Secret). The last
  console approver cannot be removed.
- **Signed in now** lists the browsers that used the console since the agent started, with
  when they signed in and were last seen. **Sign out** ends a session and its live streams
  at once. Sign-outs are kept in `console-sessions.json` next to the audit log, so a restart
  does not bring them back.

A new token is shown once, in the browser of the approver who asked, and stays on screen
while the agent restarts. Copy it and send it privately. It is registered with the redactor
and is never audited, logged, or shown again; the audit log only records who added, rotated,
or removed whom. On Kubernetes this tab needs `console.editSettings` and `existingSecret`;
without them it is read-only.

## Pausing changes

**The operations center** at the top of Overview: a greeting by the time of day (by name for
`console:<name>`), a live clock in a ring that shows the overall posture (all systems normal,
degraded, or attention required), key numbers, the attention queue, and a light for each
connected system and each listed database. It uses the console's theme, light or dark.

The key numbers are approvals waiting, pods up, deployments ready, pipelines today (ran,
passed, failed, running), databases ready, investigations today, changes this week, and
spend against the budget. Pipelines today counts the runs that started today in your time
zone, from the runs each pipeline card lists (GitLab and GitHub cards list the latest 20 per
project). When a project's whole list is from today, older runs of today were not listed,
and the number shows a `+`.

**Databases** are configurable, wherever they run:

- **Any database the agent can reach** (standalone, Amazon RDS or Aurora, another cloud, or a
  cluster service): turn on the **Databases** connector and add each one under Settings
  (engine, host, user, optional SSH tunnel), then enter its password under Secrets, where it
  is tested first. The agent connects with fixed status queries: ok, degraded (connections
  nearly used up, a lagging replica), or down (with why). See
  [the Databases connector](connectors/databases.md).
- **A database in Kubernetes, by its pods:** list it in the Kubernetes connector's `databases`
  setting as `namespace/name` (a StatefulSet or Deployment, in one of the connector's
  `namespaces`). Its light comes from its pods: ready, degraded (some pods not ready), or down
  (none running), with restarts. No database credentials are needed.

Both count in **Databases ready**, each gets a light under Systems, and one that is down or
degraded goes in the queue. With neither set, no databases are shown.

The queue lists what needs someone, worst first, each tagged critical, action, warning, or
info: failing pods, a database down, connectors down, the budget used up, approvals waiting,
a pause, deployments not ready, failed runs or jobs, a database not fully ready, the budget
near its limit, and today's investigations. Each line opens the page with the detail. It is
built from the agent's status, its records, and the dashboard's read tools, never the model,
so it costs nothing and sends nothing to the model. **Request a full briefing** opens Chat
with that question ready; nothing is sent until you send it.

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
