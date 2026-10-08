# Kodra AI Agent image. Build from the repo root:
#   docker build -f docker/Dockerfile -t ghcr.io/kodra-io/kodra-agent:dev .
#
# Debian slim, not Alpine: the Python MCP servers depend on native wheels (pydantic-core and
# others) that are published for glibc. Every base image and tool is pinned.

FROM ghcr.io/astral-sh/uv:0.12.21 AS uv
FROM docker:29.8.2-cli AS docker-cli
FROM alpine/helm:4.3.0 AS helm

# Production dependencies of the agent and its workspace packages, from the lockfile.
FROM node:24.21.0-trixie-slim AS build
RUN npm install --global --no-audit --no-fund pnpm@12.8.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent/package.json apps/agent/
COPY packages/schema/package.json packages/schema/
COPY packages/connectors/package.json packages/connectors/
COPY packages/templates/package.json packages/templates/
RUN pnpm install --prod --frozen-lockfile --filter "@kodra-agent/agent..."
COPY packages packages
COPY apps/agent apps/agent
COPY docker/mcp docker/mcp

# MCP servers, preinstalled so the agent starts them without downloading anything:
# release binaries (SHA-256 verified), PyPI servers (hash-locked), npm servers (npm ci).
FROM build AS mcp
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
ENV KODRA_MCP_DIR=/opt/kodra-mcp UV_PYTHON_DOWNLOADS=never
RUN node apps/agent/scripts/install-mcp.ts

FROM node:24.21.0-trixie-slim
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 kodra \
 && useradd --system --uid 10001 --gid kodra --home-dir /home/kodra --create-home \
      --shell /usr/sbin/nologin kodra \
 # The audit log volume. World-writable with the sticky bit, so the agent can also run as
 # the host user that owns the bundle folder (see the bundle README).
 && install -d -m 1777 /var/lib/kodra-agent \
 && install -d -o kodra -g kodra /etc/kodra-agent
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# BuildKit builds (`docker build`) need the buildx plugin; the legacy builder is deprecated.
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx \
     /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
# `aws eks get-token` only, for EKS kubeconfigs (not the AWS CLI).
COPY --chmod=755 docker/aws /usr/local/bin/aws
COPY --from=mcp /opt/kodra-mcp /opt/kodra-mcp
COPY --from=build /app /app
# Caches go to /tmp, so the root filesystem can be read-only.
ENV NODE_ENV=production \
    KODRA_MCP_DIR=/opt/kodra-mcp \
    KODRA_AGENT_CONFIG=/etc/kodra-agent/kodra-agent.yaml \
    XDG_CACHE_HOME=/tmp/.cache \
    DOCKER_CONFIG=/tmp/.docker \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false
USER 10001:10001
WORKDIR /etc/kodra-agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/apps/agent/src/bin.ts"]
CMD ["--help"]
