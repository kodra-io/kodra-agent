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
      'README.md',
    ]);
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
    expect(service['image']).toBe('ghcr.io/kodra-io/kodra-agent:0.1.0');
    expect(service['read_only']).toBe(true);
    expect(service['cap_drop']).toEqual(['ALL']);
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
    expect(file(build, 'README.md')).toContain('## Docker socket warning');
  });

  it('README has the quickstart, permissions, approvals, and uninstall', () => {
    const readme = file(bundle, 'README.md');
    expect(readme).toContain('1. `docker compose run --rm kodra-agent init`');
    expect(readme).toContain('**GitHub (read-write-approved)**');
    expect(readme).toContain('Never pushes to the default branch.');
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

  it('quickstart installs the pinned chart into the agent namespace', () => {
    expect(quickstartCommands(kubernetesDraft()).at(-1)).toBe(
      'helm install platform-agent oci://ghcr.io/kodra-io/charts/kodra-agent --version 0.1.0 --namespace kodra-agent -f values.yaml --set-file config=kodra-agent.yaml',
    );
  });
});
