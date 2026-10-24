# Slack

Developer notes for working on the code. Moved from `CLAUDE.md`.

- Slack (M5): Bolt sits behind `src/slack/api.ts`; logic is tested with `fakeSlack()`. Approvals check Slack user ids (`init` turns `@name` into ids via `users:read`). Investigations run with `readOnly: true`. `chat` and `run` share `startRuntime()`.
