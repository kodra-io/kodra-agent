# Claude Code model provider

**What:** Claude as the agent's model through the official Claude Code binary and the user's
own Claude sign-in, instead of an API key (`spec.model.provider: claude-code`).
**Pinned:** Claude Code 2.1.311 (stable channel, built 2026-10-26), downloaded on first start
and checked against its SHA-256.
**Decided:** 2026-11-07 (B7, approved by Omar).

## Why it is allowed

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
allows "an end user signing in to the unmodified Claude Code binary with their own Claude
subscription", including where a product runs Claude Code. It does not allow a product to offer
its own Claude.ai login, or to collect, store, or pass along Claude credentials. So:

- The agent runs the **unmodified** binary, as Anthropic publishes it. It does not use the Agent
  SDK libraries, which are meant to run on an API key.
- The user signs in with **Anthropic's own flow** (`claude auth login`, through
  `kodra-agent claude-code login`), on their own agent. The login is stored in Claude Code's
  config directory on the agent's volume (`CLAUDE_CONFIG_DIR`). The agent never reads, copies,
  or logs it, and the configurator has no field for it.
- Or the user puts a token from `claude setup-token` in their own `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN`. It is their secret in their environment, registered with the
  redactor like every other.
- Every user signs in with their own plan. Kodra never pays for, resells, or passes along
  anyone's Claude usage.
- **Usage limits:** Pro and Max limits "assume ordinary, individual usage". An agent that
  watches alerts all day can reach them. When it does, a question fails with "reached your
  plan's usage limit" until the limit resets.

The image does not include Claude Code: preinstalling it in a product needs Anthropic's
Commercial Terms. It is downloaded only when this provider is chosen.

## How a turn runs

```
claude -p --output-format stream-json --verbose --model <name> --system-prompt <the agent's>
  --tools "" --strict-mcp-config --mcp-config <file> --allowedTools mcp__kodra
  --permission-mode dontAsk --setting-sources "" --disable-slash-commands
  --no-session-persistence --max-turns <spec.limits.maxSteps>
```

- **No tools of its own.** `--tools ""` turns off every built-in tool (shell, files, web).
  The agent checks the tool list Claude Code reports at start, and stops it if any tool is not
  one of the agent's.
- **The agent's tools over MCP.** For each turn, the agent serves the same tools a turn
  with any other model gets on a local MCP server (`127.0.0.1`, a random port, a random bearer
  token in a file only the agent's user can read). Each call runs the policy check, the
  approval, the redaction, the untrusted-output wrapping, and the audit, exactly as before.
  The server stops when the turn ends.
- **Nothing else loads:** no settings, hooks, memory, CLAUDE.md, plugins, MCP servers from
  elsewhere, or saved sessions. It runs in an empty temporary folder.
- **Environment:** Claude Code inherits only `PATH`, `HOME`, the locale, the agent's proxy and
  CA settings, its config directory, and the optional token. Never the agent's other secrets.
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, and `DISABLE_AUTOUPDATER`
  turn off its telemetry, error reports, and updates (golden rule 7; the version is pinned).
- **Approvals take time:** `MCP_TOOL_TIMEOUT` is the turn's timeout, so a call can wait for a
  person; the turn's own timeout still ends it.
- **Limits:** `--max-turns` is the step limit. The token budget and a model pin stop the run
  after a step. Usage comes from the stream, and the totals from its final result.
- **Calls without tools** (the model test in the console, proposed CI fixes, the summary at a
  limit) run the same binary with no MCP server, through an AI SDK model (`ClaudeCodeModel`).

## Setup

Compose:

```sh
docker compose run --rm kodra-agent claude-code login    # once; Anthropic's own sign-in
docker compose up -d
```

The pinned build (about 300 MB) and the sign-in go to the agent's volume, under
`/var/lib/kodra-agent/claude-code`.

Kubernetes: put a `claude setup-token` token in the agent's secret as
`CLAUDE_CODE_OAUTH_TOKEN` (`kodra-agent init` asks for it). Without `persistence.enabled`, the
volume is an `emptyDir`: a sign-in made with `kubectl exec` is lost when the pod restarts, and
the binary is downloaded again. Claude Code needs memory too: raise `resources.limits.memory`
to at least `1Gi`.

`kodra-agent doctor` runs `claude auth status` and shows the sign-in method and plan (never the
account's email). `kodra-agent claude-code status` does the same; `logout` signs out.

On a developer's machine (no `KODRA_CLAUDE_CODE_DIR`), the agent uses the `claude` on the
`PATH` and its usual sign-in. `KODRA_CLAUDE_BIN` points it at another binary.

## Limits

- Pinned builds for Linux x64 and arm64 only (the image). Elsewhere, set `KODRA_CLAUDE_BIN`.
- Each turn starts Claude Code fresh. Earlier messages are replayed as text, without earlier
  tool results; the agent's answers keep what it found.
- The console's chat shows each block of the answer when it is complete, not word by word.
- The estimated cost in the console does not apply: the plan pays.

## Codex: parked

`codex exec` has no way to turn off its own shell tool. Even its read-only sandbox can read
every file the agent can, including `.env` and kubeconfigs, which breaks golden rule 1. It is
parked in `docs/roadmap.md` until Codex can run with only the agent's tools.

## Tests

- `src/claude-code.test.ts`: the command line, the environment, the stream parser, the prompt,
  runs against a fake `claude` (`test-fixtures/fake-claude.ts`: tools over MCP, a built-in tool
  refused, the turn limit, a budget stop, errors, a timeout, an abort, the bearer token, real
  totals), `claude auth status` without the email, and the checked download.
- `src/agent.test.ts` (Claude Code): through `runTurn`, a read is policy-checked and audited, a
  blocked call stays blocked, a denied change is not run, and a secret in tool output never
  reaches Claude Code.
- `src/claude-code.e2e.test.ts`: the real binary, signed in (`KODRA_CLAUDE_CODE_E2E=1`).
