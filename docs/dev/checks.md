# Scheduled checks

Developer notes for working on the code. Moved from `CLAUDE.md`. User docs: `docs/checks.md`.

- Checks (M27): see `docs/checks.md`. `spec.checks.schedules` (local time, days, zone; `scheduleDue` in `packages/schema/src/schedule.ts`, one run per local date, catch-up within an hour). `src/checks/`: `rules.ts` turns the Dashboard's parsed cards, alerts, and the agent's own state into findings (no model, no new reads); `state.ts` (`checks.json`) splits new, ongoing, and fixed, and keeps a finding open when its check could not run; `runner.ts` ticks every minute in `run`; `setup.ts` shares one `ConnectorDashboard` with the console. Console route `checks` and action `checks/run` (any signed-in user, not posted). Tests use `ctx.checksNow` and the fake MCP server's `--pods <file>`.
