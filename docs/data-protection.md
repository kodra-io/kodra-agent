# Data protection and model routing

Customer data in logs, errors, and tool output is masked before it leaves the agent, and an
environment can keep its data with one model (PLAN-v0.2 M13).

## What is masked

```yaml
spec:
  dataProtection:
    redact: [cards, ibans, emails, phones] # the profile's default when left out
    patterns:
      - name: customer-id
        regex: '\bCUST-[0-9]{8}\b'
```

| Detector   | Matches                                                     | Kept out by                                    |
| ---------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `cards`    | 13 to 19 digits, spaces or dashes allowed                   | Luhn checksum, and a card brand's first digits |
| `ibans`    | Country code, check digits, then 11 to 30 characters        | mod-97 checksum                                |
| `emails`   | `name@domain.tld`                                           | Shape only                                     |
| `phones`   | International format only: `+` or `00`, then 8 to 15 digits | Local formats are never matched                |
| `patterns` | Your regular expressions, each with a name                  | Your expression (it must not match empty text) |

Defaults by profile: `starter` masks `cards` and `ibans`; `team` and `strict` mask all four.

The checksums and strict shapes keep operational data untouched: timestamps, UUIDs, image
digests, trace and span IDs, ports, metric values, Kubernetes resource versions, versions, and
commit SHAs. `src/data-protection.test.ts` holds these cases.

### Placeholders keep meaning

A masked value becomes a placeholder like `[email:7f3a]`. Within one run of the agent, the
same value always gets the same placeholder, so the model can still see that one customer
appears in many errors. The tag is the first 16 bits of an HMAC-SHA256 whose key is random,
made when the agent starts, and never stored: after a restart, the same customer gets a
different placeholder, and nobody can work back from a placeholder to the value.

### Where it runs

Masking is part of the redactor, after secrets, so it covers every way out: everything sent
to the model (tool output, alerts, your own messages), the audit log, Slack, the console, and
logs. Streamed answers hold back a short tail, so a value split across pieces is still masked.
The console shows your own messages as you typed them (secrets still masked); the model gets
the masked text.

Audit records count what was masked, by type, never the values:

```json
{
  "event": "tool.call",
  "detail": "refund to [email:7f3a] on [card:1c09]",
  "redactions": { "email": 1, "card": 1 }
}
```

## Model routing

```yaml
spec:
  model: { provider: anthropic, name: '<model-id>', apiKey: '${env:ANTHROPIC_API_KEY}' }
  models:
    local:
      provider: ollama
      name: '<model-id>'
      baseUrl: http://ollama.ai-tools:11434
  environments:
    - name: production
      namespaces: [payments]
      model: local
```

- Named models are checked by `init` and `doctor` like the main model. One whose key is
  missing is not available, and environments that pin it refuse their data rather than send
  it elsewhere.
- **A tool result pins the conversation.** A call is placed in an environment the same way an
  approval is (its namespace and repo). When its result comes from an environment with a
  model, the conversation switches to that model before the result is sent, so the default
  model never sees it.
- **The pin lasts.** The rest of the conversation stays on the pinned model, in later turns
  too, in Slack threads, console chats, and `kodra-agent chat`, because the history now holds
  that data.
- **One pin per conversation.** Reading another environment that pins a different model
  stops the turn: "this conversation already uses the local model for production. Ask about
  partner in a new conversation".
- **Calls that cannot be placed.** A read that names no namespace or repo (pods across every
  namespace, a metrics query) may return data from any environment, so it counts as touching
  every environment that pins a model. When those pin different models, it is refused.
- **Alert investigations** pick the model from the alert's `namespace` label before the first
  call.
- Usage, cost, and the monthly budget are recorded per model.
