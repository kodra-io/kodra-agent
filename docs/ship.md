# The ship flow

`kodra-agent ship` takes a repository from source code to a reviewed pull request with a
Dockerfile, a CI pipeline, and a Helm chart, all built and checked before anyone is asked
to approve anything.

```sh
kodra-agent ship acme/payments-api              # a configured GitHub repo or GitLab project
kodra-agent ship acme/payments-api --branch dev # start from dev and target it
kodra-agent ship ./payments-api                 # a local folder: files are written, no PR
```

It needs Docker and Helm where it runs, so run it on a workstation or a CI runner. It does not
run inside the Kubernetes deployment, which never gets the Docker socket (SPEC section 9).

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
   - CI matching the source: GitHub Actions (builds on PRs, pushes to GHCR from the default
     branch, lints the chart; actions and Helm pinned) or GitLab CI (Docker-in-Docker, the
     project registry).
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

Without a terminal there is nobody to approve, so nothing is pushed. Every step is in the
audit log: the approval request and decision, the push, the PR call, and any model call.

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
