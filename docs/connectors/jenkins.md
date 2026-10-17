# Jenkins connector

**Server:** [`lanbaoshen/mcp-jenkins`](https://github.com/lanbaoshen/mcp-jenkins) 3.5.0 (PyPI `mcp-jenkins`)
**Decided:** 2026-10-17

## Why this server

| Check       | Finding                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| License     | MIT                                                                                                                       |
| Maintenance | Active: 3.6.0 released 2026-10-13, 3.5.0 on 2026-08-28, about 150 stars                                                   |
| Runtime     | Python, stdio. The image installs it from `docker/mcp/pypi/mcp-jenkins.txt` (hash-locked), like the other PyPI servers    |
| Controls    | `--read-only` drops the tools that change things; Jenkins permissions on the token's user still apply to every call       |
| Telemetry   | None found in the docs                                                                                                    |
| Version     | 3.5.0, not 3.6.0: the newest release was four days old when this was decided, so the previous one is pinned (as with npm) |

Considered: the official [Jenkins MCP plugin](https://github.com/jenkinsci/mcp-server-plugin) (MIT, from the Jenkins project). It runs inside Jenkins and speaks MCP over HTTP, so every user would have to install a plugin on their Jenkins, the agent would need a remote MCP transport, and the version would be whatever that Jenkins runs. It is a candidate later, for teams that already run it.

## How it runs

```
uvx --from mcp-jenkins==3.5.0 mcp-jenkins [--read-only]
```

Environment: `JENKINS_URL` and `JENKINS_USERNAME` (from config), `JENKINS_PASSWORD` (the API token secret, never on the command line), `JENKINS_TIMEOUT=30`.

**Important:** this server loads a `.env` from its working directory or a parent. The connector host starts every server in its own empty, private temporary folder, so it never reads the bundle's `.env`.

## Tool classification

From `listTools` on the real 3.5.0 server (35 tools; 28 with `--read-only`).

**Read**, limited to the configured `jobs` (a job's full name, or anything under a listed folder):
`get_item`, `get_item_parameters`, `get_build`, `get_build_parameters`, `get_build_console_output`, `get_build_scripts`, `get_build_test_report`, `get_all_build_artifacts`, `get_build_artifact`, `get_build_artifact_url`, `get_pending_inputs`.

**Read**, across the controller (what the token's user can see): `get_all_items`, `query_items`, `get_all_views`, `get_view`, `get_running_builds`, `get_all_queue_items`, `get_queue_item`, `get_all_nodes`, `get_node`, `get_all_plugins`, `get_plugin`, `get_plugin_dependency_graph`, `get_plugins_with_backup`, `get_plugins_with_problems`, `get_plugins_with_updates`. Give the agent a Jenkins user that can see only the jobs it should.

**Write** (approval, listed jobs only): `stop_build`.

**Destructive** (blocked unless `destructiveActions: require-approval`, then approval; listed jobs only): `build_item` (starts a build, which can deploy) and `submit_input` (proceeds or aborts a pipeline input step).

**Never exposed** (`hiddenTools`):

- `run_groovy_script`: runs any script on the controller.
- `get_item_config`, `get_node_config`: return config.xml, which can hold credentials.
- `set_item_config`, `set_node_config`: replace a job's or node's configuration.
- `cancel_queue_item`: takes a queue id, not a job, so the job list cannot limit it.

## Guards

`fullname` must be a listed job or under a listed folder (`arg-in-setting` with `prefix`). A
name with an empty, `.` or `..` segment, a backslash, or a `%` is refused, so
`team-a/../team-b` cannot step outside `team-a`.

## Dashboard

The **Jobs** card lists the configured jobs from `get_all_items` with their state from the
job color (blue passed, red and yellow failed, `_anime` running), failed first, with links.
Jobs outside the list are not shown. Recorded output: `apps/agent/src/test-fixtures/dashboard/jenkins-items.json`.

## Doctor

`jenkins.who-am-i` calls `GET /me/api/json` with the user and token. It passes only when
Jenkins answers with that user's id, since Jenkins can answer a bad token as `anonymous`.
