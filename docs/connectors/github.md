# GitHub and GitHub Actions connectors

**Server:** [`github/github-mcp-server`](https://github.com/github/github-mcp-server) v1.13.0, one binary for both connectors
**Decided:** 2026-10-03, for M4b

## Why this server

| Check       | Finding                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| License     | MIT                                                                                |
| Maintenance | GitHub's official server: commits daily, releases weekly, about 33k stars          |
| Runtime     | A single Go binary per platform; the GitHub and GitHub Actions connectors share it |
| Controls    | `--read-only`, `--toolsets`, `--exclude-tools`, `--lockdown-mode`                  |
| Telemetry   | None found in the docs or flags                                                    |

## Pinning

Release archives for all four platforms, pinned by SHA-256 from the project's published `github-mcp-server_1.13.0_checksums.txt`. `pnpm mcp:fetch` re-verifies every download.

## How it runs

```
github-mcp-server stdio --lockdown-mode --toolsets repos,issues,pull_requests \
  --exclude-tools merge_pull_request,pull_request_review_write,search_code,search_commits,search_repositories,create_repository,fork_repository \
  [--read-only]                                # access: read-only
# GitHub Actions: the same binary with --toolsets actions
```

The token is passed in `GITHUB_PERSONAL_ACCESS_TOKEN`. GitHub Actions uses the GitHub connector's token (it `requires` that connector); add `Actions: read` to the token.

**Lockdown mode** is on: the server hides issue and pull request content from users without push access, which reduces prompt injection from public repositories.

## Tool classification

From `listTools` on the real binary (repos, issues, pull_requests, and actions toolsets):

| Tools                                                                                                                                     | Risk        | Guards                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| 19 reads: commits, files, labels, releases, tags, issues, branches, pull requests, collaborators, `search_issues`, `search_pull_requests` | read        | `owner/repo` must be a configured repo                                                                  |
| `create_branch`, `create_or_update_file`, `push_files`                                                                                    | write       | configured repo, and the branch must **not** be the default branch (a missing branch means the default) |
| `create_pull_request`                                                                                                                     | write       | configured repo, and `head` must not be the default branch                                              |
| Issue and review comments, `issue_write`, `sub_issue_write`, `update_pull_request`, `update_pull_request_branch`                          | write       | configured repo                                                                                         |
| `delete_file`                                                                                                                             | destructive | configured repo, not the default branch                                                                 |
| `actions_get`, `actions_list`, `get_job_logs`                                                                                             | read        | the GitHub connector's repos                                                                            |
| `actions_run_trigger`                                                                                                                     | destructive | runs, reruns, or cancels workflows, which can deploy                                                    |

**Excluded at the server and never exposed:**

- `merge_pull_request`: it writes the default branch; a human merges (SPEC section 9)
- `pull_request_review_write`: an agent approval could satisfy branch protection
- `search_code`, `search_commits`, `search_repositories`: they search all of GitHub, outside the configured repos, and widen prompt-injection exposure
- `create_repository`, `fork_repository`: outside the configured repos

## Default branch protection

At startup the agent reads each configured repo once (`GET /repos/{owner}/{repo}`) to learn its default branch. The policy engine blocks any commit, file change, branch creation, or pull request head on that branch. If the lookup fails, writes to that repo are blocked for the session instead of guessed.

## Proposed changes

Branch, file, and pull request tools are mapped in the manifest's `changeSteps`, with argument
names checked against the input schemas of github-mcp-server v1.13.0. To show a diff, the agent reads each file
once from the API with the connector's token, and again right before the write. See
[fixes.md](../fixes.md).
