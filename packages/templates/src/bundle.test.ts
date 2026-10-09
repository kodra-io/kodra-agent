import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { generateBundle, quickstartCommands } from './bundle.ts';
import { composeDraft, kubernetesDraft, withConnector } from './test-drafts.ts';

const file = (bundle: ReturnType<typeof generateBundle>, path: string) =>
  bundle.files.find((f) => f.path === path)?.content ?? '';

describe('compose bundle', () => {
  const bundle = generateBundle(composeDraft());

  it('has the files from SPEC section 7', () => {
    expect(bundle.root).toBe('kodra-agent-payments-team-agent');
    expect(bundle.files.map((f) => f.path)).toEqual([
      'kodra-agent.yaml',
      '.env.example',
      '.gitignore',
      'docker-compose.yml',
      'slack-app-manifest.yaml',
      'README.md',
    ]);
  });

  it('slack-app-manifest.yaml sets Socket Mode, buttons, events, and the connector scopes', () => {
    const manifest = parse(file(bundle, 'slack-app-manifest.yaml')) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: {
        socket_mode_enabled: boolean;
        interactivity: { is_enabled: boolean };
        event_subscriptions: { bot_events: string[] };
      };
    };
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im']);
    expect(manifest.oauth_config.scopes.bot).toEqual([
      'app_mentions:read',
      'chat:write',
      'im:history',
      'im:read',
      'im:write',
      'users:read',
    ]);
    expect(file(bundle, 'README.md')).toContain('From an app manifest');
  });

  it('.env.example has variable names and comments only, never values', () => {
    const lines = file(bundle, '.env.example').trim().split('\n');
    const assignments = lines.filter((l) => !l.startsWith('#') && l.trim() !== '');
    expect(assignments).toEqual([
      'ANTHROPIC_API_KEY=',
      'GITHUB_TOKEN=',
      'SLACK_BOT_TOKEN=',
      'SLACK_APP_TOKEN=',
    ]);
    expect(file(bundle, '.env.example')).toContain('put it at ./secrets/kubeconfig');
  });

  it('.gitignore keeps .env and secrets out of git', () => {
    expect(file(bundle, '.gitignore').split('\n')).toEqual(
      expect.arrayContaining(['.env', '.env.*', '!.env.example', 'secrets/']),
    );
  });

  it('docker-compose.yml is valid YAML, hardened, and mounts file secrets read-only', () => {
    const compose = parse(file(bundle, 'docker-compose.yml')) as {
      services: { 'kodra-agent': Record<string, unknown> };
    };
    const service = compose.services['kodra-agent'];
    expect(service['image']).toBe('ghcr.io/kodra-io/kodra-agent:0.1.3');
    expect(service['read_only']).toBe(true);
    expect(service['cap_drop']).toEqual(['ALL']);
    // The root filesystem is read-only; MCP servers get private folders under /tmp.
    expect(service['tmpfs']).toEqual(['/tmp']);
    // Compose fills this from .env; the README sets it to the host user on Linux.
    expect(service['user']).toBe('${KODRA_AGENT_USER:-10001:10001}');
    expect(service['volumes']).toContain('./secrets:/secrets:ro');
    expect(JSON.stringify(service['volumes'])).not.toContain('docker.sock');
  });

  it('mounts the Docker socket only for Docker build access, with a warning', () => {
    const readOnly = generateBundle(withConnector(composeDraft(), 'docker'));
    expect(file(readOnly, 'docker-compose.yml')).not.toContain('docker.sock');

    const build = generateBundle(
      withConnector(composeDraft(), 'docker', { access: 'read-write-approved' }),
    );
    const compose = file(build, 'docker-compose.yml');
    expect(compose).toContain('"/var/run/docker.sock:/var/run/docker.sock"');
    expect(compose).toContain('WARNING: the Docker socket');
    const service = (parse(compose) as { services: Record<string, Record<string, unknown>> })
      .services['kodra-agent'];
    expect(service?.['group_add']).toEqual(['${KODRA_DOCKER_GID:-0}']);
    expect(file(readOnly, 'docker-compose.yml')).not.toContain('group_add');
    const readme = file(build, 'README.md');
    expect(readme).toContain('## Docker socket warning');
    expect(readme).toContain('KODRA_DOCKER_GID=$(getent group docker | cut -d: -f3)');
    expect(readme).toContain('docker compose run --rm kodra-agent ship <owner/repo>');
  });

  it('README has the quickstart, permissions, approvals, and uninstall', () => {
    const readme = file(bundle, 'README.md');
    expect(readme).toContain('1. `docker compose run --rm kodra-agent init`');
    expect(readme).toContain('echo "KODRA_AGENT_USER=$(id -u):$(id -g)" >> .env');
    expect(readme).toContain('**GitHub (read-write-approved)**');
    expect(readme).toContain('Never pushes to the default branch and never merges.');
    expect(readme).toContain('approval from: @omar');
    expect(readme).toContain('Destructive actions are blocked.');
    expect(readme).toContain('## Uninstall');
  });
});

describe('kubernetes bundle', () => {
  it('has values.yaml and rbac.yaml instead of docker-compose.yml', () => {
    const bundle = generateBundle(kubernetesDraft());
    expect(bundle.files.map((f) => f.path)).toEqual([
      'kodra-agent.yaml',
      '.env.example',
      '.gitignore',
      'values.yaml',
      'rbac.yaml',
      'README.md',
    ]);
    expect(file(bundle, 'docker-compose.yml')).toBe('');
  });

  it('values.yaml references a Secret and holds no secret values', () => {
    const values = parse(file(generateBundle(kubernetesDraft()), 'values.yaml')) as Record<
      string,
      unknown
    >;
    expect(values['existingSecret']).toBe('platform-agent-secrets');
    expect(values['rbac']).toEqual({ create: false });
    expect(JSON.stringify(values)).not.toMatch(/token|apiKey/i);
  });

  it('rbac.yaml is one Role and RoleBinding per namespace, read verbs only', () => {
    const docs = parseAllDocuments(file(generateBundle(kubernetesDraft()), 'rbac.yaml')).map(
      (d) =>
        d.toJS() as {
          kind: string;
          metadata: { namespace: string };
          rules?: { verbs: string[] }[];
        },
    );
    expect(docs.map((d) => `${d.kind}/${d.metadata.namespace}`)).toEqual([
      'Role/api',
      'RoleBinding/api',
      'Role/web',
      'RoleBinding/web',
    ]);
    const verbs = docs.flatMap((d) => d.rules ?? []).flatMap((r) => r.verbs);
    expect(new Set(verbs)).toEqual(new Set(['get', 'list', 'watch']));
    expect(docs.some((d) => d.kind.startsWith('Cluster'))).toBe(false);
  });

  it('adds patch on deployments only for read-write access', () => {
    const rbac = file(generateBundle(kubernetesDraft('read-write-approved')), 'rbac.yaml');
    expect(rbac).toContain('verbs: ["patch"]');
    expect(rbac).not.toMatch(/delete|create|\*/);
  });

  it('never mounts the Docker socket, even with Docker build access', () => {
    const draft = withConnector(kubernetesDraft(), 'docker', { access: 'read-write-approved' });
    const all = generateBundle(draft)
      .files.map((f) => f.content)
      .join('\n');
    expect(all).not.toContain('docker.sock:/var/run/docker.sock');
  });

  it('skips rbac.yaml without the Kubernetes connector', () => {
    const draft = kubernetesDraft();
    delete draft.connectors['kubernetes'];
    expect(generateBundle(draft).files.map((f) => f.path)).not.toContain('rbac.yaml');
    expect(quickstartCommands(draft)).not.toContain('kubectl apply -f rbac.yaml');
  });

  it('quickstart runs init from the pinned image, so no local CLI is needed', () => {
    expect(quickstartCommands(kubernetesDraft())).toContain(
      'docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$PWD:/work" -w /work ghcr.io/kodra-io/kodra-agent:0.1.3 init --target kubernetes --namespace kodra-agent',
    );
    const readme = file(generateBundle(kubernetesDraft()), 'README.md');
    expect(readme).toContain('add\n`--dry-run` to the `init` command');
    // EKS: the same init, plus ~/.aws read-only and AWS_PROFILE for `aws eks get-token`.
    expect(readme).toContain('### EKS clusters');
    expect(readme).toContain(
      'docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -e AWS_PROFILE -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$HOME/.aws:/home/kodra/.aws:ro" -v "$PWD:/work" -w /work ghcr.io/kodra-io/kodra-agent:0.1.3 init --target kubernetes --namespace kodra-agent',
    );
    // The default command does not mount ~/.aws.
    expect(quickstartCommands(kubernetesDraft()).join('\n')).not.toContain('.aws');
  });

  it('quickstart installs the pinned chart into the agent namespace', () => {
    expect(quickstartCommands(kubernetesDraft()).at(-1)).toBe(
      'helm install platform-agent oci://ghcr.io/kodra-io/charts/kodra-agent --version 0.1.3 --namespace kodra-agent -f values.yaml --set-file config=kodra-agent.yaml',
    );
  });
});
