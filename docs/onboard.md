# Onboarding a repo

`kodra-agent onboard` does what a DevOps engineer does first with a repo they have never
seen: work out what the app is and what it needs, find the risks, write down the questions
for the team, and then containerize and package it.

```sh
kodra-agent onboard acme/payments-api    # a configured GitHub repo or GitLab project
kodra-agent onboard ./payments-api       # a local folder: files are written, no PR
```

It takes the same options as `ship` (`--branch`, `--max-fixes`).

## 1. Understand (read-only)

The repo is cloned the same way `ship` clones it. The analysis reads file contents only:
nothing in the repo is run.

| Finding                               | From                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app: stack, port, health endpoint | The `ship` detection. An unsupported stack or a monorepo is reported, not a stop                                                                                                                                                                                            |
| Services in the repo                  | Folders with their own build file, one or two levels down                                                                                                                                                                                                                   |
| What it depends on                    | Library names in `pom.xml`, `build.gradle`, `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, and images in Compose files: PostgreSQL, MySQL or MariaDB, MongoDB, Redis, RabbitMQ, Kafka, AWS, Elasticsearch or OpenSearch, email                            |
| Settings it reads                     | `process.env`, `import.meta.env`, `os.getenv`, `os.environ`, `System.getenv`, `os.Getenv`, Spring `${NAME}` placeholders, and `.env.example`. Names that look like credentials (`*_PASSWORD`, `*_TOKEN`, `*_KEY`, `DATABASE_URL`, ...) are marked secret. Tests are skipped |
| Committed credentials                 | The redactor's token patterns. Only the file, line, and rule are kept; the value never leaves the scan. References such as `${DB_PASSWORD}` are skipped. A committed `.env` is a risk whatever it holds                                                                     |
| Migrations                            | Flyway, Liquibase, Alembic, Prisma, Django, and plain SQL folders                                                                                                                                                                                                           |
| Tests                                 | The test command, when tests exist                                                                                                                                                                                                                                          |
| Gaps                                  | A Dockerfile that runs as root or uses unpinned images, CI that never runs tests, a missing lockfile, unpinned Python packages, no health endpoint                                                                                                                          |

The report ends with questions for the team (which database instance each environment
uses, where the secrets live, who owns the service) and the next steps the agent does not
do yet (deploy, monitoring, vulnerability scans, a runbook).

## 2. Act

- **Report.** Printed in the terminal.
- **Tell the team.** When Slack is configured, the risks and questions are posted to the
  agent's channel. This needs no approval: it only goes to the team's own channel, and it
  names credentials by location only.
- **Ship with what it found.** The `ship` flow runs (see [ship.md](ship.md)), with two
  additions:
  - The chart's `values.yaml` lists the settings the code reads, commented out, to fill in
    per environment. Secrets are loaded from a Secret the team creates: set
    `envFromSecret` to its name. The file names the variables and gives the
    `kubectl create secret` command, never a value.
  - `ONBOARDING.md` is added to the PR (an existing one is left alone), and the PR
    description lists the questions.
- **One approval** covers pushing the branch (`kodra-agent/onboard-<id>`) and opening the PR,
  as in `ship`. A denied approval pushes nothing.

A repo the ship flow cannot handle yet (another stack, pnpm, a monorepo) gets the report
and the Slack post, and nothing else.

## What it does not do

- Fix a committed credential. Rewriting git history is destructive, and only a person can
  rotate the credential. The report and Slack say where it is.
- Run the app's tests, scan for vulnerabilities, or deploy. These are later milestones
  (M21, M23, M9c).
- Ask the model. The report is built from fixed rules, so it is the same on every run.
