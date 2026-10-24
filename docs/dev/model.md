# Model calls and providers

Developer notes for working on the code. Moved from `CLAUDE.md`.

- Since 0.1.2: `runTurn` caches (explicit breakpoint after the last tool + Anthropic top-level `cacheControl`), stops on `spec.limits` with a price-weighted token budget, and always ends with an answer (summary call with `toolChoice: 'none'`).
- AI SDK v7: `generateText({ instructions, messages, tools, stopWhen: stepCountIs(n) })`, `dynamicTool` + `jsonSchema`, accumulated messages are `result.responseMessages`; tests use `MockLanguageModelV4` from `ai/test`.
- Model picker: `src/model-options.ts` (`listProviderModels` with the agent's key, `modelOptions` with manifest prices and this month's usage, `testModel`: one 5-token call). Routes `settings/models` and `settings/model-test` (approvers); `settings/apply` runs `checkModelChange` first. Tests swap `SettingsDeps.createModel` and `endpoints`.
- Provider switch: `SettingsStore.switchCandidate` (manifest settings, typed key or the one in .env, the provider's probes, its model list; writes nothing), `testCandidate`, then route `settings/provider-switch` writes the key and `spec.model` (`patchConfigText` with `model.provider` replaces the whole node, secrets as references). `modelDestination` is part of `policyDiffers` and shows as `{ code: 'model' }` in `moreAccess`.
- Model context (`src/model-context.ts`): `promptTokens` estimates the prompt (4 chars per token); `deps.contextWindow` (Ollama: `/api/ps`, cached 30 s) makes `runTurn` refuse a prompt that cannot fit (`stoppedBy: 'context'`) and flag a call whose prompt filled the window. Doctor's Ollama row fails below 16,384; `SettingsStore.contextWarning` warns in the model test and stops a provider switch until `acceptSmallContext`. Ollama streams usage (`includeUsage`).
