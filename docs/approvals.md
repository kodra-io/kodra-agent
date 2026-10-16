# Approvals: profiles and environments

Every change the agent makes needs a human approval. This page explains who can approve,
how many approvals a change needs, and how to set that per environment (M10, see
`PLAN-v0.2.md`).

## Profiles

`spec.profile` picks defaults for a kind of organization. A profile sets defaults only:
every value can be set explicitly in `kodra-agent.yaml`.

|                            | `starter` (default)                        | `team`                                       | `strict`                                            |
| -------------------------- | ------------------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| For                        | One person or a small team getting started | Several people and more than one environment | Regulated, audited, or change-managed organizations |
| Approving your own request | Allowed                                    | Allowed, except in production                | Never                                               |
| Approvers needed           | 1                                          | 1                                            | 2 in production, 1 elsewhere                        |

`resolvePolicy` in `packages/schema/src/policy.ts` is the only place these defaults live.
The configurator, `doctor`, and the agent all call it.

## Environments

An environment is a named group of Kubernetes namespaces and repositories with its own
approval rules.

```yaml
spec:
  profile: team
  environments:
    - name: production
      production: true # gets the profile's stricter rules
      namespaces: [api, web]
      repos: [acme/deploy]
      approvers: ['U0123ABCD', 'U0456EFGH', 'console:lead'] # optional
      approvals: # optional; left out, the profile decides
        minApprovers: 1
        allowSelfApproval: false
        expiresAfterMinutes: 30
    - name: staging
      namespaces: [staging]
  policy:
    approvals:
      approvers: ['U0123ABCD', 'console:lead'] # the default, for everything else
```

- A tool call belongs to an environment when its namespace or repository argument is in
  it. The agent reads those arguments from the connector's guards (a namespace guard with
  `scope: namespace`, and every repo guard), so it needs no per-tool list.
- A call with no namespace or repository, or one outside every environment, uses
  `spec.policy`.
- A namespace or repository belongs to one environment. Repositories compare ignoring case.
- An environment without `approvers` uses the default approvers.
- One request covers one environment. A call or a proposed change that touches two
  environments, or one environment and something outside it, is refused with "make one
  change per environment".

## Rules nobody can satisfy

The config fails to load (and the configurator blocks the download) when an environment
cannot get the approvals it needs. Because the person who asked may be an approver,
forbidding self-approval needs one more approver than the minimum. For example:

> Production changes need someone other than the requester. Add a second approver.

## How a request is decided

Each request carries a ballot with its environment's rules. Slack, the console, and the
terminal all vote through it:

- A vote counts only from an approver listed for that environment.
- The requester is identified from who asked: a Slack user id, a console account, the
  terminal (`cli`), or `agent:monitor` for alert investigations, which are read-only anyway.
- The requester's own approval is refused where self-approval is not allowed. They can
  still deny their own request.
- An approval at the terminal counts as the requester's own. Where self-approval is not
  allowed, `kodra-agent chat` refuses without asking and says to approve in Slack or the
  console.
- `minApprovers` different people must approve. Any denial ends the request at once.
- The expiry covers the whole request, however many approvals it needs.
- Slack and the console show the environment and the progress, for example "1 of 2
  approved by @sara". Approvals made in the console show on the Slack message too.
- The audit log records every refused click (with the reason), each counted vote
  (`approval.vote`), and the final decision with every approver's name.

## Approvers are Slack user ids

Slack names can be changed by their owners, so at runtime the agent accepts only Slack
user ids (`U…` or `W…`) and console approvers (`console:<name>`).

- You can write `@name` in the config or the configurator. `kodra-agent init` looks each
  name up once with the bot token (`users:read`), shows who matched, and writes the ids
  into `kodra-agent.yaml`, keeping its comments. With `--non-interactive`, it writes them
  only when every name matches exactly one person, and otherwise writes nothing.
- A name left in the config approves nothing. `run` warns about it at startup, and
  `doctor` fails with a hint to run `init`.

## Change control (M11)

### Freeze windows

```yaml
environments:
  - name: production
    production: true
    namespaces: [api, web]
    freezes:
      - name: weekend
        timezone: Asia/Amman
        weekly: { from: 'Thu 18:00', to: 'Sat 23:59' } # may wrap past Saturday
      - name: year-end
        timezone: Asia/Amman
        dates: { from: '2026-12-28', to: '2027-01-02' } # whole local days
```

- Each freeze has `weekly` or `dates`, not both, and its own IANA time zone. Times are local
  wall-clock times in that zone, so daylight saving changes never move a window. Both ends
  are included, to the minute.
- A write in a frozen environment is not run on its own. It goes to approval as a
  break-glass request: Slack, the console, and the terminal say the environment is frozen
  and until when, and approving needs a written reason. In `strict`, it needs two approvers.
- An approved override is audited twice (on the decision, and as an `override` record) and
  announced in the agent's Slack channel. Console Activity shows it too.

### Change references

```yaml
approvals:
  requireChangeRef: true # on by default for strict production
  changeRefPattern: '^CHG[0-9]{7}$' # optional
```

- The first approval must give a reference that matches the pattern: in a Slack form, in
  the console's confirm step, or at the terminal prompt. Later approvers see it.
- It is stored on the audit record (`changeRef`) and shown with the decision. The agent
  makes no calls to any ticketing system.

### Policy changes from the console

A console save is a policy change when it changes the profile, environments, approvers
(including adding or removing someone in People), approval rules, destructive actions, or a
connector's access or scope. Undo counts too when what it puts back is a policy change.

| Profile   | What happens                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `starter` | Audited, like any settings change.                                                                                                    |
| `team`    | Audited, and announced in Slack with the diff.                                                                                        |
| `strict`  | Held until a second approver approves it (the person who saved cannot). It then applies, checked again first, and the agent restarts. |

A held add in People creates no token. Once it is approved, create the new approver's token
with Rotate.

### The agent never changes itself

Every Kubernetes write tool carries a `not-self` guard. On Kubernetes the chart tells the
agent its own namespace and names (`KODRA_AGENT_SELF_NAMESPACE`, `KODRA_AGENT_SELF_NAMES`),
and any write to those objects, or to pods named after them, is blocked even with approval.
A missing namespace counts as the agent's own, and a manifest that cannot be read is
blocked. `src/self-protection.test.ts` fails if a new write-capable tool is added without
the guard or a reason it cannot reach the agent.
