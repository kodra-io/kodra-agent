# Networks

Developer notes for working on the code. Moved from `CLAUDE.md`. User docs: `docs/network.md`.

- Networks (M12): see `docs/network.md`. `src/network.ts` resolves `spec.network` (proxy URLs are secret refs, registered with the redactor), applies them to the agent process at startup (`http.setGlobalProxyFromEnv`, `tls.setDefaultCACertificates`; Node 24.14+), and returns `childEnv` for MCP servers (`HostOptions.networkEnv`) and ship's git/helm/docker, with a combined CA file for Go and Python. `spec.ship.baseImageMirrors` rewrites pinned base images (`mirrorImage`). The chart's `networkpolicy.yaml` parses the config; `pnpm test:proxy` runs the image behind mitmproxy.
