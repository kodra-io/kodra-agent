# Hallway test

L4 in PLAN.md: someone who has never seen the project goes from the configurator to a first
answer, using only the README. Every place they get stuck is fixed before v0.4.0.

## Set up

- A person who has not worked on Kodra AI Agent, with a laptop that has Docker.
- Something for the agent to read that they understand: a kind cluster with one broken
  deployment works (`evals/scenarios/crashloop/manifests.yaml`), or their own cluster.
- A model key, or Ollama with a model that supports tools.
- They start at the top of the README on GitHub. Nobody explains anything; answer only to
  unblock them, and note that you did.

## While they work

For each place they slow down or stop, note:

| Time | Where (page, step, command) | What they expected | What happened | Unblocked by |
| ---- | --------------------------- | ------------------ | ------------- | ------------ |
|      |                             |                    |               |              |

Also note the time to the bundle download, to `docker compose up`, and to the first answer.

## Done when

They get a first answer from the agent without help. If anyone had to step in, fix that
place (copy, docs, or a bug), then run the test again with someone new.

Keep the notes in the private field-notes repo, not here. Only the fixes come back as PRs.
