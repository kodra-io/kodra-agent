# Security policy

## Supported versions

| Version | Supported                      |
| ------- | ------------------------------ |
| 0.2.x   | Yes                            |
| < 0.2   | No: upgrade to the latest 0.2. |

Security fixes go into the latest release. Until 1.0, there are no backports to older minor
versions.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/kodra-io/kodra-agent/security/advisories/new)
(the repository's Security tab, then "Report a vulnerability"). Do not open a public issue.

Include what you found, how to reproduce it, the version, and what an attacker could do with
it. Do not include real secrets, tokens, or customer data: the agent's own canary tests show
how to demonstrate a leak with made-up values.

What to expect: we aim to confirm we received it within 5 working days, and to share an
assessment within 15. A confirmed issue gets a fix in a release, a GitHub security advisory,
and credit if you want it.

## Scope

In scope: the agent (`apps/agent`), its image and Helm chart, the console (`apps/console`), the
configurator (`apps/configurator`), the bundles it generates, and the connector manifests.

Especially interesting:

- A secret reaching the model, Slack, the console, logs, metrics, traces, or the audit log.
- A change running without the approval the policy requires, or a destructive or
  unclassified tool running at all.
- Instructions in tool output (repo files, logs, issues, alerts) that make the agent act.
- A push to a default branch.
- An audit record changed without `kodra-agent audit verify` noticing.

Out of scope: the third-party MCP servers, model providers, and services themselves (report
those to their maintainers; tell us if the agent should pin a fixed version), and attacks that
need someone who can already change the agent's config, environment, or image.

## How to verify a release

See [Verify a release](README.md#verify-a-release) in the README. The security model is
described in [docs/security](docs/security/review-brief.md).
