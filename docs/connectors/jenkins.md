# Jenkins connector

**Server:** the official [Jenkins MCP Server plugin](https://github.com/jenkinsci/mcp-server-plugin) (`mcp-server`), with [`lanbaoshen/mcp-jenkins`](https://github.com/lanbaoshen/mcp-jenkins) 3.5.0 (PyPI `mcp-jenkins`) as the fallback for a Jenkins without the plugin
**Decided:** 2026-10-17 (the community server); 2026-10-31 for B4 (the plugin by default)

## Which server

| `server`           | Server                                           | When                                            |
| ------------------ | ------------------------------------------------ | ----------------------------------------------- |
| `plugin` (default) | The MCP Server plugin, at `<url>/mcp-server/mcp` | Jenkins 2.541.3 or newer with the plugin        |
| `community`        | `mcp-jenkins` 3.5.0, run by the agent            | A Jenkins where the team cannot install plugins |

## Why the plugin (B4)

| Check       | Finding                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| License     | MIT, from the Jenkins project (jenkinsci)                                                                                        |
| Maintenance | Active, released through the Jenkins update center. Tested with 0.222.v9d40a_8d624e4 on Jenkins 2.580.1                          |
| Transport   | Streamable HTTP at `/mcp-server/mcp`, through the agent's proxy and CA settings. Nothing runs in the agent                       |
| Auth        | The Jenkins user and API token as Basic auth, the same credentials as the community server                                       |
| Controls    | Jenkins permissions on the token's user apply to every call                                                                      |
| Setup       | Install the plugin (Manage Jenkins, then Plugins). It needs the git and JUnit plugins for its SCM and test tools, and a root URL |
| Telemetry   | None found                                                                                                                       |

The version is whatever that Jenkins runs. The e2e test below pins the one we checked, and a
tool a later plugin adds is unclassified, so it is blocked and not offered until it is
classified here.

## Plugin: tools

From `listTools` on a real Jenkins 2.580.1 with plugin 0.222.v9d40a_8d624e4 (23 tools).

**Read**, limited to the configured `jobs` by `jobFullName` (a listed job, or anything under a
listed folder): `getJob`, `getBuild`, `getBuildLog`, `searchBuildLog`, `getReplayScripts`,
`getTestResults`, `getFlakyFailures`, `getJobScm`, `getBuildScm`, `getBuildChangeSets`.

**Read**, across the controller (what the token's user can see): `getJobs`, `getQueueItem`,
`whoAmI`, `getStatus`, `findJobsWithScmUrl`. Give the agent a Jenkins user that can see only
the jobs it should.

**Write** (approval, listed jobs only): `cancelBuild`, by job and build number. `queueId` is
refused: a queue item is not tied to a job, so the job list cannot limit it.

**Destructive** (blocked unless `destructiveActions: require-approval`, then approval; listed
jobs only): `triggerBuild` and `rebuildBuild`. Starting a build can deploy.

**Never exposed** (`hiddenTools`):

- `replayBuild`: runs edited pipeline code.
- `createPipeline`: creates a job with any pipeline script.
- `updateBuild`: renames builds and rewrites their descriptions.
- `getSystemLog`, `getLogRecorders`: the controller's log can hold credentials.

## Plugin: e2e test

`docker/test/jenkins-mcp` builds a throwaway Jenkins (pinned image and plugin versions, a
test-only user, a folder `team-a` with one job, and a job outside it). The real-server CI job
runs `apps/agent/src/jenkins-plugin.e2e.test.ts` against it: every tool the plugin offers is
classified or hidden, every classified tool still exists, and the agent reads `team-a` jobs
through the host while `other` is blocked. Locally:

```
docker build -t kodra-jenkins-mcp docker/test/jenkins-mcp
docker run -d --name kodra-jenkins -p 127.0.0.1:18080:8080 kodra-jenkins-mcp
KODRA_JENKINS_MCP_URL=http://127.0.0.1:18080 KODRA_JENKINS_MCP_TOKEN=kodra-e2e-password \
  pnpm --filter @kodra-agent/agent exec vitest run src/jenkins-plugin.e2e.test.ts
```

## Why the community server (fallback)

| Check       | Finding                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| License     | MIT                                                                                                                       |
| Maintenance | Active: 3.6.0 released 2026-10-13, 3.5.0 on 2026-08-28, about 150 stars                                                   |
| Runtime     | Python, stdio. The image installs it from `docker/mcp/pypi/mcp-jenkins.txt` (hash-locked), like the other PyPI servers    |
| Controls    | `--read-only` drops the tools that change things; Jenkins permissions on the token's user still apply to every call       |
| Telemetry   | None found in the docs                                                                                                    |
| Version     | 3.5.0, not 3.6.0: the newest release was four days old when this was decided, so the previous one is pinned (as with npm) |

## Community server: how it runs

```
uvx --from mcp-jenkins==3.5.0 mcp-jenkins [--read-only]
```

Environment: `JENKINS_URL` and `JENKINS_USERNAME` (from config), `JENKINS_PASSWORD` (the API token secret, never on the command line), `JENKINS_TIMEOUT=30`.

**Important:** this server loads a `.env` from its working directory or a parent. The connector host starts every server in its own empty, private temporary folder, so it never reads the bundle's `.env`.

## Community server: tools

From `listTools` on the real 3.5.0 server (35 tools; 28 with `--read-only`).

**Read**, limited to the configured `jobs` (a job's full name, or anything under a listed folder):
`get_item`, `get_item_parameters`, `get_build`, `get_build_parameters`, `get_build_console_output`, `get_build_scripts`, `get_build_test_report`, `get_all_build_artifacts`, `get_build_artifact`, `get_build_artifact_url`, `get_pending_inputs`.

**Read**, across the controller (what the token's user can see): `get_all_items`, `query_items`, `get_all_views`, `get_view`, `get_running_builds`, `get_all_queue_items`, `get_queue_item`, `get_all_nodes`, `get_node`, `get_all_plugins`, `get_plugin`, `get_plugin_dependency_graph`, `get_plugins_with_backup`, `get_plugins_with_problems`, `get_plugins_with_updates`.

**Write** (approval, listed jobs only): `stop_build`.

**Destructive** (blocked unless `destructiveActions: require-approval`, then approval; listed jobs only): `build_item` (starts a build, which can deploy) and `submit_input` (proceeds or aborts a pipeline input step).

**Never exposed** (`hiddenTools`):

- `run_groovy_script`: runs any script on the controller.
- `get_item_config`, `get_node_config`: return config.xml, which can hold credentials.
- `set_item_config`, `set_node_config`: replace a job's or node's configuration.
- `cancel_queue_item`: takes a queue id, not a job, so the job list cannot limit it.

## Guards

The job name (`jobFullName` on the plugin, `fullname` on the community server) must be a
listed job or under a listed folder (`arg-in-setting` with `prefix`). A name with an empty,
`.` or `..` segment, a backslash, or a `%` is refused, so `team-a/../team-b` cannot step
outside `team-a`.

## Dashboard

The **Jobs** card shows the configured jobs with their state from the job color (blue passed,
red and yellow failed, `_anime` running), failed first, with links. Jobs outside the list are
not shown. On the plugin it reads each listed job with `getJob` and each listed folder's jobs
with `getJobs` (one folder level). On the community server it reads `get_all_items`. Recorded
output: `apps/agent/src/test-fixtures/dashboard/jenkins-plugin-*.json` and `jenkins-items.json`.

## Doctor

`jenkins.who-am-i` calls `GET /me/api/json` with the user and token. It passes only when
Jenkins answers with that user's id, since Jenkins can answer a bad token as `anonymous`.
