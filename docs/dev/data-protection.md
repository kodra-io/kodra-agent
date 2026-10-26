# Data protection and model routing

Developer notes for working on the code. Moved from `CLAUDE.md`. User docs: `docs/data-protection.md`.

- Data protection and model routing (M13): see `docs/data-protection.md`. `src/data-protection.ts` (`DataMasker`: Luhn, mod-97, strict shapes, HMAC placeholders keyed per run) runs inside `Redactor.redact` after secrets; `redactSecrets` is for showing people their own text; audit records get `redactions` counts. Named models (`spec.models`, built in runtime as `deps.models`) and `environments[].model`: `runTurn` routes with `prepareStep`, a `ModelRouter` places each tool call (`pinnedEnvironments`), and `TurnResult.pin` is kept per conversation and passed back.
