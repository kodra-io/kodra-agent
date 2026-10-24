# Air-gapped installs

A cluster with no internet access needs three things from outside, copied once into your
own registry: the agent image, the Helm chart, and a model it can reach. The MCP servers are
inside the image already, checked against their pinned SHA-256 at build time, so nothing
else is downloaded at runtime.

## 1. Mirror the image and the chart

On a machine that can reach both sides:

```sh
VERSION=0.3.10
REGISTRY=harbor.example.com/mirror

# The image (multi-arch), and the chart as an OCI artifact.
docker buildx imagetools create \
  --tag "$REGISTRY/kodra-io/kodra-agent:$VERSION" "ghcr.io/kodra-io/kodra-agent:$VERSION"
helm pull oci://ghcr.io/kodra-io/charts/kodra-agent --version "$VERSION"
helm push "kodra-agent-$VERSION.tgz" "oci://$REGISTRY/charts"
```

Check the image's signature before you copy it (`cosign verify`, see `docs/packaging.md`).

## 2. Install from your registry

```sh
helm install my-agent "oci://harbor.example.com/mirror/charts/kodra-agent" --version 0.3.10 \
  --namespace kodra-agent -f values.yaml --set-file config=kodra-agent.yaml \
  --set image.registry=harbor.example.com/mirror
```

On Docker Compose, set `KODRA_AGENT_IMAGE=harbor.example.com/mirror/kodra-io/kodra-agent:0.3.10`
in `.env`.

## 3. Use a model you can reach

- **Ollama** inside your network: `provider: ollama` with `baseUrl` pointing at it. No key.
  Give it a context window big enough for the agent: its instructions and tool descriptions
  alone can be tens of thousands of tokens with a few connectors on, and Ollama runs a model
  with 4,096 by default, cutting off the start of a longer prompt without an error. Set
  `OLLAMA_CONTEXT_LENGTH=65536` (or more) where Ollama runs and restart it. The agent checks:
  `doctor` fails below 16,384, the console's model test and provider switch say when the
  window is too small, and a question whose prompt cannot fit is refused rather than answered
  from a cut-off prompt. From a container, reach Ollama on the host at
  `http://host.docker.internal:11434`, not `localhost`.
- **A gateway** to a hosted model: `provider: anthropic` or `openai` with `baseUrl` set to the
  gateway, through your proxy if it needs one (`docs/network.md`).

## 4. Keep the rest inside

- Point connectors at internal services: GitLab or GitHub Enterprise URLs, in-cluster
  Prometheus and Grafana.
- Slack needs `slack.com` over HTTPS (through a proxy is fine). Without it, use the web
  console for chat and approvals.
- For the ship flow, mirror the base images and set `spec.ship.baseImageMirrors`
  (`docs/network.md`).
- Turn on the NetworkPolicy (`networkPolicy.enabled: true`) so the agent can reach only what
  its config names.
