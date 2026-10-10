# Fixes: proposed changes

The agent can make changes that take several steps, like creating a branch, editing files,
and opening a pull request, as one **proposed change**. You review it once, with a diff, and
approve or deny the whole thing.

1. **The model proposes.** It calls `propose_change` with a title, a reason, and the steps
   (tool calls with their arguments).
2. **The agent checks before anyone is asked.** Every step goes through the policy first. If
   any step is blocked (a write to a default branch, a repo you did not list, a destructive
   tool under the deny policy), nothing is proposed and the model is told which step and why.
3. **You see one preview.** Each file edit shows as a diff against the file's current content,
   read from GitHub or GitLab. Branches and pull requests show as one line each. Other tools
   show their arguments. Secrets are removed.
4. **One approval.** In Slack, the console, or the terminal, the same way as any other
   approval: only an approver, only before it expires, only once. A denial can carry a reason.
5. **The agent runs exactly what you approved,** in order, with no model in the loop. Before
   each file write it reads the file again; if it changed since the preview, the run stops
   there and nothing after it runs. The run also stops at the first step that fails.

Every step is in the audit log: the request, the decision with the approver's name, and each
tool call with `change <id> step n/m`.

## What you can ask

Things like "raise the replica count in deploy/values.yaml of acme/api to 3 and open a PR",
or "fix the typo in the README and open a merge request". The agent reads the files it needs,
then proposes the change. The connector needs **read and write, with approval** access, and
the repo must be in its list.

## Limits

- At most 20 steps in one change.
- A preview of more than 40,000 characters is refused, not cut short: split the change.
- Files over 1 MB are not previewed, so a change to them is refused.
- In Slack, a long preview is cut at about 2,700 characters, with a note to see it in the
  console. The console always shows the whole preview.
- Investigations of alerts are read-only and cannot propose changes (that comes in M9b).
- On GitLab, `push_files` is destructive (it can also delete and move files), so changes
  write files one by one with `create_or_update_file`.

## How the agent reads files

To build a diff, the agent reads each file once from the forge's API with the connector's
own token: `GET /repos/{repo}/contents/{path}?ref=` on GitHub, and
`GET /projects/:id/repository/files/:path/raw?ref=` on GitLab. It reads at the branch the
write starts from: the source branch when the change creates the branch, otherwise the
branch itself. It reads again right before the write. These are reads only, with the same
token the connector already uses.

Which arguments hold the repo, branch, path, and content is declared per tool in the
connector manifest (`changeSteps`), checked against each server's input schemas.
