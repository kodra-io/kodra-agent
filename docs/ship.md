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
     branch, and lints the chart (actions, images, and Helm pinned); or a thin caller of the
     team's shared pipeline.
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
   A human reviews and merges. Nothing is deployed.
8. **Build** (Jenkins only). The agent finds the Jenkins job for the branch, waits for it to
   build, or starts it after a second approval, and reports the result (see
   [Jenkins](connectors/jenkins.md#ship-with-jenkins-b5)).

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
- The chart's image tag defaults to its `appVersion`; CI tags images with the commit SHA, so
  deploy with `--set image.tag=<sha>`.
- Watching the rollout after a deploy (SPEC section 9, step 6) is not part of this flow yet.

## Sample repos

`examples/ship/` holds one small app per stack. The `ship` CI job builds and smoke-tests each
one with the real Docker, lints its chart with the real Helm, and opens the PR through the
fake MCP server against a local git remote:

```sh
KODRA_SHIP_E2E=1 pnpm --filter @kodra-agent/agent exec vitest run src/commands/ship.test.ts
```
