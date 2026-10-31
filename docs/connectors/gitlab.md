# GitLab and GitLab CI connectors

**Server:** GitLab's built-in MCP server (GitLab 19.5 or newer), with [`zereight/gitlab-mcp`](https://github.com/zereight/gitlab-mcp) 2.1.68 (npm `@zereight/mcp-gitlab`) as the fallback for older GitLab
**Decided:** 2026-10-03 for M4b (the community server); 2026-10-31 for B4 (the built-in server by default)

## Which server

The `server` setting on the GitLab connector picks the server for both connectors:

| `server`            | Server                                          | When                                                                       |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `builtin` (default) | GitLab's own MCP server, at `<url>/api/v4/mcp`  | GitLab 19.5 or newer, gitlab.com included                                  |
| `community`         | `@zereight/mcp-gitlab` 2.1.68, run by the agent | Older self-managed GitLab, or no admin who can turn the built-in server on |

GitLab CI follows the GitLab connector's setting, so the two never run different servers.

## Why the built-in server (B4)

| Check       | Finding                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintenance | Part of GitLab itself, generally available since 19.5 on every tier. It is updated with the instance, so nothing is installed or pinned here |
| Transport   | Streamable HTTP at `/api/v4/mcp`, through the agent's proxy and CA settings                                                                  |
| Auth        | A fine-grained personal access token with the MCP server permission, sent as `Authorization: Bearer`. Legacy tokens get 403                  |
| Controls    | `X-Gitlab-Enabled-Mcp-Server-Toolsets` limits the tools offered; the token's own project access applies to every call                        |
| Setup       | An administrator (or the top-level group's Owner on gitlab.com) turns on "Allow access to the MCP server"                                    |
| Telemetry   | Nothing beyond GitLab's own request logs                                                                                                     |

It covers what the agent needs: merge requests, branches, commits with file contents, work
items, and, for GitLab CI, pipelines and jobs. The 2026-10-03 reasons for not using it (beta,
OAuth only) no longer hold.

**Not verified yet:** the exact names of the fine-grained token permissions, and Bearer auth
against a self-managed instance. The tool list and argument names were read from gitlab.com
(19.6.0-pre). `apps/agent/src/mcp/host-http.test.ts` and the GitLab ship test cover the
agent's side with a fake server; a test against a real instance needs a token, so CI does not
run one.

## Why the community server (fallback)

| Check       | Finding                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| License     | MIT                                                                                                                                   |
| Maintenance | Active: releases every few days, about 2k stars                                                                                       |
| Runtime     | Node, which the agent image already has. Run at a pinned version; M7 installs it from a lockfile                                      |
| Controls    | `--permission-mode readonly`/`modify` (modify removes every delete and teardown tool), `GITLAB_TOOLSETS`, `GITLAB_DENIED_TOOLS_REGEX` |
| Telemetry   | None found in the docs                                                                                                                |

## Built-in server: tools

Toolsets: `core,merge_requests,work_items,repository` for GitLab, `ci` for GitLab CI. Every
call names one listed project with `project_id` (`id` for `list_branches`, `list_pipelines`,
`get_pipeline`, and `get_job`). `url` and `group_id` are refused (`arg-absent`), since either
would name another project or a whole group past the project list.

| Tools                                                                                                                                         | Risk        | Guards                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `get_project`, `get_repository_file`, `list_repository_tree`, `list_commits`, `get_commit`, `list_tags`, `list_releases`, `get_merge_request` | read        | listed project, no `url`                                                                                     |
| `list_merge_requests`, `get_work_item`, `list_work_items`, `get_work_item_types`                                                              | read        | listed project, no `url`, no `group_id`                                                                      |
| `list_branches`, `list_project_members`, `get_mcp_server_version`                                                                             | read        | listed project                                                                                               |
| `add_branch`                                                                                                                                  | write       | listed project, not the default branch                                                                       |
| `add_commit`                                                                                                                                  | write       | listed project, not the default branch, no `start_project`; each action is a whole-file `create` or `update` |
| `save_merge_request`                                                                                                                          | write       | listed project, `source_branch` not the default branch, no `target_project_id`                               |
| `save_note`, `save_work_item`                                                                                                                 | write       | listed project, no `url`, no `group_id`                                                                      |
| GitLab CI: `list_pipelines`, `get_pipeline`, `get_job`, `get_artifact_file`                                                                   | read        | the GitLab connector's projects                                                                              |
| GitLab CI: `save_pipeline`                                                                                                                    | destructive | runs a new pipeline, which can deploy; no `pipeline_id`                                                      |

`add_commit` refuses `delete`, `move`, and `chmod` actions, and `old_str`, `new_str`,
`previous_path`, and `encoding` on any action (`items-allowed`). Only whole files are written,
so the proposed change shows exactly what lands. `save_pipeline` with a `pipeline_id` retries
or cancels an existing pipeline, named by a global id that no project check covers, so it is
refused.

**Never exposed** (`hiddenTools`): `accept_merge_request` (merging),
`save_merge_request_review` (approving), `fork_repository`, `save_project`, `link_work_items`,
`list_projects`, `list_groups`, `list_todos`, `get_user`, `search`, `semantic_search`,
`search_labels`, `get_pages_content`, `get_saved_view_work_items`; for GitLab CI,
`manage_pipeline` and `get_pipeline_jobs`. Searches and listings across the instance cannot be
limited to the project list. A tool a later GitLab adds is unclassified, so it is blocked and
not offered.

## Community server: how it runs

```
npx --yes --package @zereight/mcp-gitlab@2.1.68 -- mcp-gitlab --permission-mode=readonly|modify
```

Environment: `GITLAB_PERSONAL_ACCESS_TOKEN` (secret), `GITLAB_API_URL` (the configured address plus `/api/v4`), `GITLAB_DENIED_TOOLS_REGEX` (below). GitLab CI adds `GITLAB_TOOLSETS=pipelines` and uses the GitLab connector's token and address (it `requires` that connector).

## Community server: limiting the tools

The server's own filters cannot express an allowlist, which we found by testing the real server:

- `GITLAB_TOOLS` **adds** tools rather than limiting them (the README suggests otherwise).
- `GITLAB_DENIED_TOOLS_REGEX` longer than 200 characters, or containing nested quantifiers, is **ignored**, and every tool is offered (it fails open, with only a log line).

So:

1. `--permission-mode` removes delete and teardown tools.
2. A short deny pattern removes the remaining dangerous tools: merges, approvals, default-branch and project changes, branch protection, repository and group creation, labels, and `execute_graphql`.
3. The manifest's `hiddenTools` lists every other tool 2.1.68 offers (69 for GitLab, 34 for GitLab CI); the host drops them. Any tool a future version adds shows up as unclassified, and the real-server CI job fails.

## Community server: tools

| Tools                                                                                                                                                  | Risk        | Guards                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| 17 reads: project, branches, files, tree, commits, commit diffs and statuses, merge requests and their diffs, files, and notes, issues and discussions | read        | `project_id` must be a configured project path (a numeric id is blocked, so the model uses the path) |
| `create_branch`, `create_or_update_file`                                                                                                               | write       | configured project, branch not the default branch                                                    |
| `create_merge_request`                                                                                                                                 | write       | configured project, `source_branch` not the default branch                                           |
| `update_merge_request`, `create_merge_request_note`, `create_issue`, `update_issue`, `create_issue_note`                                               | write       | configured project                                                                                   |
| `push_files`                                                                                                                                           | destructive | it can also delete and move files; configured project, not the default branch                        |
| GitLab CI: `list_pipelines`, `get_pipeline`, `list_pipeline_jobs`, `get_pipeline_job`, `get_pipeline_job_output`, `get_pipeline_test_report_summary`   | read        | the GitLab connector's projects                                                                      |
| GitLab CI: `create_pipeline`, `retry_pipeline`, `retry_pipeline_job`, `play_pipeline_job`                                                              | destructive | starting or retrying pipelines can deploy                                                            |

**Never exposed:** `get_pipeline_variables` and `get_pipeline_schedule_variable`, which return CI/CD variable values (often secrets), plus every merge, approval, and default-branch tool.

## Default branch protection

At startup the agent reads each configured project once (`GET /api/v4/projects/:path`) to learn its default branch, and the policy engine blocks commits and branch writes to it. A failed lookup blocks writes to that project. This works the same with either server.

## Proposed changes

Branch, file, and merge request tools are mapped in each server's `changeSteps`, with argument
names checked against the real input schemas (gitlab.com's built-in server, and
@zereight/mcp-gitlab 2.1.68). `kodra-agent ship` finds the branch and merge request tools by
their change step, so it works with either server. To show a diff, the agent reads each file
once from the API with the connector's token, and again right before the write. See
[fixes.md](../fixes.md).
