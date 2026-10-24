# Scheduled checks

Once a day, or whenever you ask, the agent looks at what it can already see and posts a
digest: what is broken, split into **new**, **still broken**, and **fixed since the last
run**. It goes to the Slack channel and to the console Overview.

Checks only read. They call no write tool and never the model, so they need no approval
and cost nothing.

## Turn them on

```yaml
spec:
  checks:
    schedules:
      - name: morning
        at: '08:30' # 24-hour local time
        days: [mon, tue, wed, thu, fri] # leave out for every day
        timezone: Asia/Amman
    quietWhenClean: false # true: post nothing when everything is fine
```

- Up to ten schedules, each with its own name, time, days, and time zone.
- Times are local wall-clock time in that zone, the same as freezes, so daylight saving
  time changes nothing. A time skipped by a clock change runs when the clock passes it.
- **Off unless configured.** The configurator offers weekdays at 09:00 in your browser's
  time zone, under "Daily checks".
- If the agent was down at the scheduled time, it runs once when it starts, up to an hour
  late. After that it waits for the next day.

## What is checked

| Check       | Reads                                                    | Finds                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pods        | Kubernetes pods in each listed namespace                 | Failing pods (critical), pending, not ready, or restarted 5 times or more                                                                                                                    |
| Deployments | Kubernetes deployments                                   | Fewer ready replicas than desired (critical at none)                                                                                                                                         |
| Warnings    | Kubernetes warning events                                | Up to five per namespace, the rest counted                                                                                                                                                   |
| Pipelines   | GitHub Actions runs, GitLab CI pipelines                 | A workflow whose latest run on the default branch failed                                                                                                                                     |
| Jobs        | Jenkins jobs                                             | Jobs whose last build failed or was unstable                                                                                                                                                 |
| Databases   | The Databases connector, and database pods in Kubernetes | Down (critical) or degraded, with the reasons                                                                                                                                                |
| Alerts      | Alertmanager, or Prometheus                              | Every firing alert; critical when its severity is critical, page, or error                                                                                                                   |
| The agent   | Its own audit log, budget, approvals, and secrets        | A broken audit chain (critical), 80% or more of the monthly budget, approvals nobody has answered, secrets that expired (critical), expire within 14 days, or were set more than 90 days ago |

The reads are the console Dashboard's cards: the same read tools, the same policy check,
and output redacted before it is parsed. A check sees only the parsed fields. The default
branch comes from the GitHub or GitLab connector; without it, `main` and `master` count as
default.

Secrets (M29b): a secret's expiry comes from the value itself, when it carries one (a
kubeconfig's token or client certificate, or any JWT). When it was set comes from the audit
log (the console records each replacement) or the secret file's time; a secret in `.env`
that was never replaced in the console has no known age. The digest names the secret, never
its value.

A check whose connector is off, or that has nothing listed, is named under "Not checked".
A card that fails to read is listed under "Could not check". A problem it found before
stays open instead of being called fixed.

## Where the digest goes

- **Scheduled runs** post to the Slack channel, or print to the agent's log without Slack.
  With `quietWhenClean: true`, a run with nothing open, nothing fixed, and nothing it could
  not check posts nothing.
- **The console Overview** shows the latest digest, the schedules, and a **Run now** button.
  Anyone signed in can press it: it reads and costs nothing. Its digest is saved and shown
  there, not posted to Slack. Each finding has an **Ask** button that fills in a question in
  Chat; nothing is sent until you send it.
- **`kodra-agent check`** runs once and prints the digest. It saves nothing, so the next
  scheduled digest still calls today's problems new. `--post` posts it to Slack and saves
  it; `--json` prints the digest as JSON. It exits 1 while anything is broken, so a script
  can use it.

## State and the audit log

`checks.json` next to the audit log holds the open findings, when each was first seen,
the last run of each schedule, and the latest digest. A restart keeps it, so a schedule
does not run twice in a day and nothing is called new again. On Kubernetes it lives on the
same volume as the audit log; with the default `emptyDir`, a new pod starts empty.

Each run is audited as `task.start` and `result` with actor `checks`: the trigger, then the
counts (new, ongoing, resolved, not checked) and whether it was posted. The digest itself
is not in the audit log. The digest ends with the audit chain head (`#seq` and hash) at
that moment, so anyone who keeps the digest can later check that nothing before it changed.

## Not yet

These checks need reads the agent does not make yet, and come in M27b: expiring
certificates, volumes filling up, deprecated APIs, and rightsizing from seven days of
usage. Scheduled changes (a weekly dependency update, say) are not planned: a change needs
an approver, and nobody is waiting at the scheduled hour.
