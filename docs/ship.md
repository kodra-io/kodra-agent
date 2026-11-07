# The ship flow

`kodra-agent ship` takes a repository from source code to a reviewed pull request with a
Dockerfile, a CI pipeline, and a Helm chart, all built and checked before anyone is asked
to approve anything.

Shipping needs the Docker connector with build access. Docker is off until you turn it on.

```sh
kodra-agent ship acme/payments-api              # a configured GitHub repo or GitLab project
kodra-agent ship acme/payments-api --branch dev # start from dev and target it
kodra-agent ship ./payments-api                 # a local folder: files are written, no PR
```

It needs Docker and Helm where it runs. Three places work:

- **A workstation or CI runner** with Docker and Helm installed.
- **The agent container on Docker Compose**, when the Docker connector has build access (the
  bundle then mounts the Docker socket): `docker compose run --rm kodra-agent ship <owner/repo>`.
  The image has git, the Docker CLI with buildx, and Helm. The app under test runs next to the
  agent, not inside it, so the agent joins a private network created for the test, reaches the
  app by name, and removes the container and the network afterwards.
- **Not the Kubernetes deployment**, which never gets the Docker socket (SPEC section 9).

To read the repo and report on it first, run `kodra-agent onboard` instead: see
[onboard.md](onboard.md).

## Steps

1. **Clone.** A shallow clone into a private temp folder, removed at the end. The token is
   passed to git as an HTTP header in environment variables. It never appears in arguments,
   the clone URL, `.git/config`, output, or the audit log. Your own git config and hooks are
   switched off for these commands.
2. **Detect** the stack from file contents (nothing is run): Spring Boot with Maven or Gradle
   (Java 17 or 21), Node.js with npm, Python with `requirements.txt` (FastAPI with uvicorn,
   Flask with gunicorn, or a plain script), and Go (a main package at the root or one under
   `cmd/`). Also the port, a health endpoint if the code has one, and what already exists.
   Anything else stops with a reason instead of a guess.
3. **Generate** only what is missing, from tested templates in `packages/templates/src/ship`:
   - `Dockerfile`: multi-stage, base images pinned to exact versions (distroless by digest),
     and a numeric non-root user.
   - `.dockerignore`: keeps `.git`, dependencies, build output, and `.env` files out of the image.
   - CI for the connected CI tool (see [Which CI](#which-ci)), in the style the team already
     uses (see [Pipeline style](#pipeline-style)): a standalone GitHub Actions workflow,
     `.gitlab-ci.yml`, or `Jenkinsfile` that runs the tests, builds the image, pushes
     `pr-<sha>` from pull requests and `<sha>` plus the chart's `appVersion` from the default
     branch, lints the chart (actions, images, and Helm pinned), and, when
     [the deploy stage](#deploy-stage) is on, deploys from the default branch; or a thin
     caller of the team's shared pipeline.
   - `charts/<name>`: deployment, service, startup, liveness, and readiness probes, resource
     requests and a memory limit, `runAsNonRoot`, a read-only root filesystem with a writable
     `/tmp`, no privilege escalation, all capabilities dropped, and no service account token.
     An existing Dockerfile, CI file, or chart is kept. An existing chart is still linted.
4. **Verify.** `docker build`, then the container is started the way the chart runs it
   (read-only root filesystem, writable `/tmp`) and must answer HTTP below 500 on its health
   endpoint, or on `/`, within two minutes. The container is always removed.
5. **Fix.** If a generated Dockerfile fails, the model gets the Dockerfile and the end of the
   log, marked as untrusted data, and proposes a corrected Dockerfile. A proposal is used only
   if it still pins every base image and runs as non-root. Then the image is verified again.
   `--max-fixes` sets the limit (default 2, 0 turns it off). A Dockerfile that was already in
   the repo is never changed. Every change the model made is listed in the PR.
6. **Package.** `helm lint` and `helm template` on the chart.
7. **Ship.** The policy engine checks both changes with the connector's own guards first: the
   repo must be configured, the connector must have `read-write-approved` access, and the new
   branch is never the default branch. One approval in the terminal then covers pushing a new
   `kodra-agent/ship-<id>` branch and opening the pull request (or merge request). The
   description explains what was detected, what each file is for, and how it was verified.
   A human reviews and merges. Nothing is deployed before the merge.
8. **Watch the CI.** The agent watches the pull request's run through the CI connector
   (Jenkins, GitHub Actions, or GitLab CI). For Jenkins it finds the job for the branch and
   starts it if Jenkins does not (see [Jenkins](connectors/jenkins.md#ship-with-jenkins-b5)).
9. **Fix or explain a failure.** The model reads the end of the log, marked as untrusted
   data. If the cause is in a file ship added, it proposes the corrected file; it is checked
   (pinned images, non-root, no new credentials, no disabled checks) and pushed as a new
   commit on the same branch, then the CI runs again, up to `--max-fixes` times. If the cause
   is in the application, its tests, or the CI system's setup, nothing is changed: the agent
   says where the problem is and what a person should do.
10. **Test in the sandbox** when the run passes and a sandbox is set up
    ([sandbox](sandbox.md), its own approval).
11. **Report:** ready to merge, or what is left for a person, with the links, in the
    terminal, the console, and Slack.

The approval in step 7 covers the branch, the pull request, starting its Jenkins build, and
the fix commits of step 9 on that branch only, and its text says so. Each one is still checked
by the policy engine and written to the audit log.

After the merge, `kodra-agent release <repo>` watches the default branch's run and its deploy
(see [After the merge](#after-the-merge)).

Without a terminal there is nobody to approve, so nothing is pushed. Every step is in the
audit log: the approval request and decision, the push, the PR call, and any model call.

## Which CI

The pipeline is written for the CI tool that builds the repo, picked in this order:

1. **`spec.ship.ci`** (`jenkins`, `github-actions`, or `gitlab-ci`; the console has it under
   Settings, Connectors). GitHub Actions only builds GitHub repos and GitLab CI only GitLab
   ones; Jenkins builds either, and a local folder.
2. **The CI the repo already has** (a workflow that builds a container, `.gitlab-ci.yml`, or a
   `Jenkinsfile`): it is kept.
3. **The CI connector that is turned on:** Jenkins, GitHub Actions, or GitLab CI. With several,
   the repo host's own CI, and the pull request says to set `spec.ship.ci`.
4. **Otherwise** the CI that comes with the repo host.

The `Jenkinsfile` runs every step in Docker on the Jenkins agent, in the same pinned images
as the other pipelines (`docker cp`, not a bind mount, so a remote Docker daemon works too).
It pushes to the Jenkins connector's `registry` with its `registryCredentials`, and the pull
request lists what Jenkins needs: a job for the repo (a multibranch pipeline builds every
branch), Docker with buildx on the agent (the Dockerfile caches dependencies with BuildKit),
and push access.

## Deploy stage

Off by default. Turn it on in the console (Settings, Connectors, Deploy stage) or in
`kodra-agent.yaml`:

```yaml
spec:
  ship:
    deploy:
      enabled: true
      target: kubernetes # or vm
      environment: staging # a GitHub or GitLab environment; from spec.environments, its rules apply
      when: default-branch # or manual: a person approves each deploy in the CI system
      credentials: KUBECONFIG_STAGING # the CI secret's name; the agent never reads it
      namespace: staging # kubernetes
      # vm:
      # host: app1.example.com
      # user: deploy
      # sshPort: 22
      # hostKey: ssh-ed25519 AAAA... # from: ssh-keyscan -t ed25519 app1.example.com
```

- **When:** only on the default branch, after the tests, the image, and the chart check pass,
  one deploy at a time. `manual` uses the CI system's own gate: a Jenkins `input` step, the
  GitHub environment's required reviewers, or a manual GitLab job. A production environment
  (`spec.environments[].production`) must use `manual`.
- **Kubernetes:** `helm upgrade --install <app> <chart> --set image.tag=<sha>
--rollback-on-failure --wait --timeout 5m` in the pinned Helm image. The pull request adds
  `deploy/ci-deployer-rbac.yaml`: a ServiceAccount, Role, and RoleBinding that can deploy to
  that namespace only, for a cluster admin to apply once. Its kubeconfig goes in the CI system
  under the `credentials` name (a Jenkins Secret file credential, a GitHub Actions secret, or
  a GitLab variable of type File).
- **VM:** `deploy/vm-deploy.sh` runs on the VM over SSH, with the host key pinned in
  `deploy/known_hosts` (never `StrictHostKeyChecking=no`). It pulls the image, replaces the
  container, waits up to 90 seconds for its health endpoint, and puts the previous image back
  if it never gets healthy. The app's settings and secrets go in `/etc/<app>.env` on the VM.
- **Jenkins and Docker networks:** when the cluster's API server is reached through a Docker
  network (kind, for example), set `DOCKER_NETWORK` on the Jenkins agent; the helper
  containers join it.
- An existing pipeline is kept, so it gets no deploy stage; the pull request says so.

## After the merge

`kodra-agent release <repo>` (or Watch the release on the console's Repos page, or asking in
chat) reads the default branch's commit, watches its CI run (the deploy stage runs in it),
then checks the deployment with the agent's own read access:

- **Kubernetes:** the Deployment runs the commit's image and every replica is ready and
  updated, or the rollout is stuck.
- **VM:** the app's health endpoint answers from the agent's network.

When the run fails or the deployment is not healthy, the agent investigates with read-only
tools, as it does for an alert (pods, events, logs, the end of the CI log), and reports what it
found and the fix it suggests. It never deploys or rolls back by itself: Helm's
`--rollback-on-failure` and the VM script already put back a failed rollout, and anything more
is a change a person approves.

## From chat

In the console chat or Slack, ask for it in plain words ("onboard kodra-io/agent-demo-app",
"test the dev branch in the sandbox", "is the release of acme/orders healthy?"). The model
uses these tools, which start the same background jobs as the Repos page:

| Tool                  | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| `kodra_repos`         | The repos it can onboard, and recent jobs                |
| `kodra_onboard`       | The whole flow above; `reportOnly` for the analysis only |
| `kodra_sandbox_test`  | A sandbox test of a branch                               |
| `kodra_watch_release` | The release check after a merge                          |
| `kodra_job`           | A job's state, report, and the end of its log            |

Only console approvers can start them. Starting one changes nothing: every push, build start,
and deploy inside it waits for an approval in the console or Slack. The result is posted to
Slack and shown on the Repos page.

## Pipeline style

Many teams build every service with one shared pipeline: a GitHub reusable workflow, or a
GitLab template included from a central project. The agent fits in instead of adding a
pipeline of its own:

1. **The repo already has CI:** it is kept.
2. **Jenkins builds the repo:** a standalone `Jenkinsfile`. Shared libraries are not read yet.
3. **`pipeline: standalone`** on the GitHub or GitLab connector: a standalone pipeline.
4. **`pipelineTemplate`** names the shared pipeline:
   `owner/repo/.github/workflows/build.yml@v1` on GitHub, `group/project:ci/build.yml@v1` on
   GitLab (several files: `a.yml,b.yml`). Pin it to a tag or commit.
5. **Otherwise (`pipeline: auto`, the default),** the agent reads the CI files of the other
   repos configured on the connector. When most of them call the same shared workflow or
   include the same template, this repo calls it too, at the ref they use. If not, it gets a
   standalone pipeline.

A caller copies how the other repos call the template (triggers, permissions, `secrets:
inherit`, stages) and fills in each input or variable:

- **Values the agent knows** from the detection: image, chart path, Java version, port, service
  name, test command, health path.
- **Values every other repo sets the same way**, or the same apart from the repo's own name
  (`sonar-project: acme_payments` becomes `acme_orders`).
- **Anything else is left empty and listed in the pull request** to set before merging: values
  that differ between the repos, and inputs the template requires that nobody sets. A value
  that looks like a credential is never copied.

When the template's repo is configured on the connector (or named in `pipelineTemplate`), the
agent reads it too: GitHub `workflow_call` inputs and required secrets, GitLab `spec:inputs`,
or, without them, the variables a GitLab template reads. Inputs it does not declare are not
passed. Nothing read here is run or sent to the model. The agent does not run the shared
pipeline: the pull request's CI does.

## Limits for now

- One service per repo. pnpm, Yarn, Bun, Poetry-only, and Django projects are not supported yet.
- The chart's image tag defaults to its `appVersion`; the deploy stage sets the commit SHA.
- One deploy target per repo. No GitOps mode, image scan, SBOM, or signing yet (parked in
  `docs/roadmap.md`).
- Releases are judged by the rollout and the health endpoint, not by metrics yet.

## Sample repos

`examples/ship/` holds one small app per stack. The `ship` CI job builds and smoke-tests each
one with the real Docker, lints its chart with the real Helm, and opens the PR through the
fake MCP server against a local git remote:

```sh
KODRA_SHIP_E2E=1 pnpm --filter @kodra-agent/agent exec vitest run src/commands/ship.test.ts
```
