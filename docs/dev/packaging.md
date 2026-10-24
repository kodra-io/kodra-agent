# Packaging, releases, and CI

Developer notes for working on the code. Moved from `CLAUDE.md`. User docs: `docs/packaging.md`.

- Packaging (M7): see `docs/packaging.md`. One version in `apps/agent/package.json`, `Chart.yaml`, and `AGENT_VERSION` (`src/release.test.ts`). A manifest version bump for a PyPI or npm server needs its lockfile in `docker/mcp` regenerated (`src/mcp/preinstall.test.ts` fails otherwise). Releases come from `v*` tags (`.github/workflows/release.yml`).
- EKS: the image's `aws` (`docker/aws` -> `src/aws-bin.ts`) only does `eks get-token` (`src/eks-token.ts`, SigV4 via `@smithy/signature-v4`), so EKS kubeconfigs work unchanged. The Kubernetes manifest inherits `AWS_*`; the host registers inherited secret-like values with the redactor.
- CI pins actions by commit SHA and runs the gitleaks binary (the gitleaks Action needs a
  license key for org repos).
- On Windows, `/var/lib/...` audit paths resolve to the current drive (for example `E:\var\lib`); doctor runs locally write there.
