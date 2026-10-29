# Test in a sandbox

`kodra-agent sandbox deploy` runs a branch for real before anyone merges it: it deploys the
image CI built for the branch, with the repo's own Helm chart, into one namespace set aside
for tests, checks that it starts and answers, reports, and removes it again.

```sh
kodra-agent sandbox deploy acme/payments-api                     # the default branch
kodra-agent sandbox deploy acme/payments-api --branch feature/x  # a pull request's branch
kodra-agent sandbox deploy acme/payments-api --keep 2h           # keep it up for 2 hours
kodra-agent sandbox list                                         # tests that are still up
kodra-agent sandbox destroy 1a2b3c4d                             # remove one now
kodra-agent sandbox sweep                                        # remove what is past its time
```

In the console, open **Repos**, pick a repo and a branch, choose how long to keep it, and
select **Test in sandbox**. Tests that are still up are listed there with **Destroy now**.

## What it does

1. **Clones the branch** and reads its commit, its chart under `charts/`, and the image
   repository in the chart's `values.yaml`. The repo needs a chart: onboard it first.
2. **Picks the tag CI pushed:** `pr-<commit>` for a branch, `<commit>` for the default
   branch, as the pipeline that `ship` and `onboard` write does. `--tag` overrides it.
3. **Asks once.** One approval covers the whole test: install, check, and remove. It goes
   through the same approval rules as any change in the sandbox namespace, and counts toward
   `spec.limits.maxWritesPerHour`.
4. **Installs** the chart as the Helm release `kt-<id>` in the sandbox, with one replica, and
   waits up to 5 minutes for it to be ready.
5. **Checks it:** calls the service through the Kubernetes API (the readiness or health path
   the code serves, else `/`) and counts any answer below 500 as up, then watches the pods for
   20 seconds for restarts.
6. **Reports** pass or fail to the terminal or the console, and to the Slack channel. When
   the image cannot be pulled or the app keeps crashing, it says so in plain words.
7. **Removes it**, unless you asked to keep it. A kept test is removed when its time is up
   (24 hours at most), or sooner with **Destroy now** or `sandbox destroy`.

## Set it up

1. Choose a namespace for tests, for example `sandbox`. It cannot be one the agent watches,
   its own namespace, `default`, or a `kube-*` namespace.
2. On the Kubernetes connector, set `sandbox` to it and give the connector
   read-write-approved access.
3. Give the agent its Role there. The Kubernetes bundle's `rbac.yaml` and the Helm chart
   (`rbac.sandbox.namespace`) include it; with your own kubeconfig, run the sandbox step under
   the kubeconfig setup steps.
4. If the images are in a private registry, create an image pull Secret in the sandbox
   namespace and set `sandboxPullSecret` to its name.

The Role lets the agent create, change, and delete ConfigMaps, Services, and Deployments in
that one namespace, read their pods, logs, and events, and call a Service through the API
server. Nothing else, and never Secrets: Helm keeps its records in ConfigMaps.

## Settings and secrets

The chart gets every setting it already has. For each secret the code reads, the test
gets a placeholder value (`sandbox-placeholder`) from a ConfigMap, so the app can start
without real credentials.

When the app needs real values to start, create a Secret named `<app>-sandbox-env` in the
sandbox namespace (where `<app>` is the chart's name) with test values only. The test loads
it after the placeholders, so its values win. The agent never reads it.

## What it removes

Only what it made. Each test is recorded in `sandbox.json`, next to the audit log, and its
release carries the labels `kodra.io/owner=kodra-agent`, `kodra.io/agent=<agent name>`, and
`kodra.io/test=<id>`. A release is removed only when both are true, so another team's
release in the same namespace, or another agent's test, is never touched.

`run` removes tests whose time is up when it starts and every 5 minutes. If the agent
stopped in the middle of a test, the sweep also removes a release of its own that is not in
`sandbox.json` once it is more than 24 hours old.

Every step is in the audit log: the request, the decision, the install, the removal, and the
result.
