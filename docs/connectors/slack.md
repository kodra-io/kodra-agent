# Slack connector

**Library:** [`@slack/bolt`](https://github.com/slackapi/bolt-js) 5.1.0 (MIT), built into the agent (not an MCP server)
**Decided:** 2026-10-03, for M5

## Why Bolt in Socket Mode

Bolt is Slack's official SDK. Socket Mode opens an outbound WebSocket to Slack, so the agent needs **no public endpoint** (SPEC section 6). The agent's Slack code sits behind a small interface (`src/slack/api.ts`); everything else is tested against a fake.

## Setup

The bundle includes `slack-app-manifest.yaml`. Paste it at api.slack.com/apps (**Create New App > From an app manifest**). It turns on Socket Mode, buttons, the `app_mention` and `message.im` events, and the bot scopes below, taken from the connector manifest so they always match. Then create an app-level token with `connections:write`.

| Token               | Scopes                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| Bot (`xoxb-`)       | `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read` |
| App-level (`xapp-`) | `connections:write`                                                                  |

`users:read` is used once at startup to turn `@name` approvers into user ids.

## Who can do what

| Action                   | Who                                              |
| ------------------------ | ------------------------------------------------ |
| Ask the agent something  | Anyone who mentions it in the configured channel |
| Direct messages          | Approvers only; others get a polite refusal      |
| Approve or deny a change | Approvers only, matched by **Slack user id**     |

Slack handles are no longer unique, so approvals are checked by user id. Config entries like `U0123ABCD` are used as is. `@name` entries are resolved once at startup by username or display name; an unknown or ambiguous name matches nobody, and the agent prints a warning.

Messages from Slack are untrusted input: they are redacted before reaching the model and never bypass the policy engine.

## Approval messages

A change request becomes a message in the thread with **Approve** and **Deny** buttons, showing the tool, the redacted arguments, the model's reason, and the expiry. A click counts only if:

- it comes from an approver (others are refused, and the attempt is audited);
- the request has not expired (it is marked expired on its own);
- the request has not been decided yet (each request is single-use).

The message is updated with the outcome, and every decision is audited with the approver's user id. On shutdown, open requests are refused.

## Alert investigations

With the Prometheus connector, `kodra-agent run` polls Alertmanager (or Prometheus) and posts each new alert's investigation to the channel. Investigations are **read-only**: every write or destructive tool is blocked, whatever the access level. To act on a finding, mention the agent and approve the change. Limits are set in `spec.monitoring` (defaults: 2 at once, 10 per hour, 60-minute cooldown per alert).
