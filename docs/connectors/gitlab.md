# GitLab and GitLab CI connectors

**Server:** [`zereight/gitlab-mcp`](https://github.com/zereight/gitlab-mcp) 2.1.68 (npm `@zereight/mcp-gitlab`), shared by both connectors
**Decided:** 2026-10-03, for M4b

## Why this server

| Check       | Finding                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| License     | MIT                                                                                                                                   |
| Maintenance | Active: releases every few days, about 2k stars                                                                                       |
| Runtime     | Node, which the agent image already has. Run at a pinned version; M7 installs it from a lockfile                                      |
| Controls    | `--permission-mode readonly`/`modify` (modify removes every delete and teardown tool), `GITLAB_TOOLSETS`, `GITLAB_DENIED_TOOLS_REGEX` |
| Telemetry   | None found in the docs                                                                                                                |

**Considered: GitLab's own MCP server.** It is built into GitLab on all tiers, but it is in beta, authenticates only with OAuth (a browser login), works over HTTP or a proxy, and must be enabled by an admin per instance or group. That does not fit an unattended agent using a token.

## How it runs

```
npx --yes --package @zereight/mcp-gitlab@2.1.68 -- mcp-gitlab --permission-mode=readonly|modify
```

Environment: `GITLAB_PERSONAL_ACCESS_TOKEN` (secret), `GITLAB_API_URL` (the configured address plus `/api/v4`), `GITLAB_DENIED_TOOLS_REGEX` (below). GitLab CI adds `GITLAB_TOOLSETS=pipelines` and uses the GitLab connector's token and address (it `requires` that connector).

## Limiting the tools: three layers

The server's own filters cannot express an allowlist, which we found by testing the real server:

- `GITLAB_TOOLS` **adds** tools rather than limiting them (the README suggests otherwise).
- `GITLAB_DENIED_TOOLS_REGEX` longer than 200 characters, or containing nested quantifiers, is **ignored**, and every tool is offered (it fails open, with only a log line).

So:

1. `--permission-mode` removes delete and teardown tools.
2. A short deny pattern removes the remaining dangerous tools: merges, approvals, default-branch and project changes, branch protection, repository and group creation, labels, and `execute_graphql`.
3. The manifest's `hiddenTools` lists every other tool 2.1.68 offers (69 for GitLab, 34 for GitLab CI); the host drops them. Any tool a future version adds shows up as unclassified, and the real-server CI job fails.

## Tool classification

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

At startup the agent reads each configured project once (`GET /api/v4/projects/:path`) to learn its default branch, and the policy engine blocks commits and branch writes to it. A failed lookup blocks writes to that project.

## Proposed changes

Branch, file, and pull request tools are mapped in the manifest's `changeSteps`, with argument
names checked against the input schemas of @zereight/mcp-gitlab 2.1.68. To show a diff, the agent reads each file
once from the API with the connector's token, and again right before the write. See
[fixes.md](../fixes.md).
