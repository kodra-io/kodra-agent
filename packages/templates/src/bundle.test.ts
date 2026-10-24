import { getConnector } from '@kodra-agent/connectors';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { digestDestination, generateBundle, quickstartCommands } from './bundle.ts';
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
    expect(service['image']).toBe('${KODRA_AGENT_IMAGE:-ghcr.io/kodra-io/kodra-agent:0.3.10}');
    expect(service['read_only']).toBe(true);
    expect(service['cap_drop']).toEqual(['ALL']);
    // The root filesystem is read-only; MCP servers get private folders under /tmp.
    expect(service['tmpfs']).toEqual(['/tmp']);
    // Compose fills this from .env; the README sets it to the host user on Linux.
    expect(service['user']).toBe('${KODRA_AGENT_USER:-10001:10001}');
    expect(service['volumes']).toContain('./secrets:/secrets:ro');
    expect(JSON.stringify(service['volumes'])).not.toContain('docker.sock');
    // Limits and rotated logs (M29).
    expect(service).toMatchObject({ mem_limit: '2g', cpus: 2, pids_limit: 512 });
    expect(service['logging']).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '5' },
    });
  });

  it('mounts the Docker socket only on the one-shot builder, only for build access', () => {
    const readOnly = generateBundle(withConnector(composeDraft(), 'docker'));
    expect(file(readOnly, 'docker-compose.yml')).not.toContain('docker.sock');

    const build = generateBundle(
      withConnector(composeDraft(), 'docker', { access: 'read-write-approved' }),
    );
    const compose = file(build, 'docker-compose.yml');
    expect(compose).toContain('"/var/run/docker.sock:/var/run/docker.sock"');
    expect(compose).toContain('WARNING: the Docker socket');
    const services = (parse(compose) as { services: Record<string, Record<string, unknown>> })
      .services;
    // The always-on agent never has the socket (M14).
    const agent = services['kodra-agent'];
    expect(JSON.stringify(agent?.['volumes'])).not.toContain('docker.sock');
    expect(agent?.['group_add']).toBeUndefined();
    expect(agent?.['restart']).toBe('unless-stopped');
    // The builder has it, runs only when started (a profile), and is just as locked down.
    const builder = services['kodra-builder'];
    expect(JSON.stringify(builder?.['volumes'])).toContain('/var/run/docker.sock');
    expect(builder?.['profiles']).toEqual(['build']);
    expect(builder?.['restart']).toBeUndefined();
    expect(builder?.['command']).toBeUndefined();
    expect(builder?.['group_add']).toEqual(['${KODRA_DOCKER_GID:-0}']);
    expect(builder?.['read_only']).toBe(true);
    expect(builder?.['cap_drop']).toEqual(['ALL']);
    expect(builder?.['image']).toBe(agent?.['image']);
    expect(builder?.['volumes']).toEqual(expect.arrayContaining(agent?.['volumes'] as string[]));
    expect(file(readOnly, 'docker-compose.yml')).not.toContain('group_add');
    expect(file(readOnly, 'docker-compose.yml')).not.toContain('kodra-builder');
    const readme = file(build, 'README.md');
    expect(readme).toContain('## Docker socket warning');
    expect(readme).toContain('KODRA_DOCKER_GID=$(getent group docker | cut -d: -f3)');
    expect(readme).toContain('docker compose run --rm kodra-builder ship <owner/repo>');
  });

  it('README has the quickstart, permissions, approvals, and uninstall', () => {
    const readme = file(bundle, 'README.md');
    expect(readme).toContain('1. `docker compose run --rm kodra-agent init`');
    expect(readme).toContain('echo "KODRA_AGENT_USER=$(id -u):$(id -g)" >> .env');
    expect(readme).toContain('**GitHub (read-write-approved)**');
    expect(readme).toContain('Never pushes to the default branch and never merges.');
    expect(readme).toContain('Profile: starter.');
    expect(readme).toContain(
      '- Every change needs one approval from @omar; the person who asked may approve it;',
    );
    expect(readme).toContain('Destructive actions are blocked.');
    expect(readme).toContain('## Uninstall');
  });

  it('README lists a console sign-in token per console approver', () => {
    const draft = {
      ...composeDraft(),
      policy: { ...composeDraft().policy, approvers: '@omar, console:on-call' },
    };
    const readme = file(generateBundle(draft), 'README.md');
    expect(readme).toContain('- `KODRA_CONSOLE_TOKEN`: the team: view and chat, cannot approve');
    expect(readme).toContain('- `KODRA_CONSOLE_TOKEN_ON_CALL`: console:on-call: can approve');
    expect(readme).toContain('You can also chat with the agent there.');
    const k8s = file(generateBundle({ ...kubernetesDraft(), policy: draft.policy }), 'README.md');
    expect(k8s).toContain("jsonpath='{.data.KODRA_CONSOLE_TOKEN_ON_CALL}' | base64 -d");
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

  // F9: scaling is a get and an update of deployments/scale. Nothing may patch or update a
  // Deployment itself, which could change its pod template.
  it('adds only get and update on deployments/scale for read-write access', () => {
    const rbac = file(generateBundle(kubernetesDraft('read-write-approved')), 'rbac.yaml');
    const writes = parseAllDocuments(rbac)
      .map((d) => d.toJS() as { kind: string; rules?: { resources: string[]; verbs: string[] }[] })
      .filter((d) => d.kind === 'Role')
      .flatMap((d) => d.rules ?? [])
      .filter((r) => r.verbs.some((v) => !['get', 'list', 'watch'].includes(v)));
    expect(writes.length).toBeGreaterThan(0);
    for (const rule of writes) {
      expect(rule).toEqual({
        apiGroups: ['apps'],
        resources: ['deployments/scale'],
        verbs: ['get', 'update'],
      });
    }
    expect(rbac).not.toMatch(/patch|delete|create|\*/);
  });

  it('grants the same write rule as the chart and the kubeconfig setup steps', () => {
    const chart = readFileSync(
      fileURLToPath(new URL('../../../charts/kodra-agent/templates/rbac.yaml', import.meta.url)),
      'utf8',
    );
    const rule = '    resources: ["deployments/scale"]\n    verbs: ["get", "update"]';
    expect(chart).toContain(rule);
    expect(file(generateBundle(kubernetesDraft('read-write-approved')), 'rbac.yaml')).toContain(
      rule,
    );
    expect(chart).not.toMatch(/patch|\*/);
    const steps = JSON.stringify(getConnector('kubernetes'));
    expect(steps).toContain('--verb=get,update --resource=deployments/scale');
    expect(steps).not.toContain('--verb=patch');
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
      'docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$PWD:/work" -w /work ghcr.io/kodra-io/kodra-agent:0.3.10 init --target kubernetes --namespace kodra-agent',
    );
    const readme = file(generateBundle(kubernetesDraft()), 'README.md');
    expect(readme).toContain('add\n`--dry-run` to the `init` command');
    // EKS: the same init, plus ~/.aws read-only and AWS_PROFILE for `aws eks get-token`.
    expect(readme).toContain('### EKS clusters');
    expect(readme).toContain(
      'docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -e AWS_PROFILE -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$HOME/.aws:/home/kodra/.aws:ro" -v "$PWD:/work" -w /work ghcr.io/kodra-io/kodra-agent:0.3.10 init --target kubernetes --namespace kodra-agent',
    );
    // The default command does not mount ~/.aws.
    expect(quickstartCommands(kubernetesDraft()).join('\n')).not.toContain('.aws');
  });

  it('quickstart installs the pinned chart into the agent namespace', () => {
    expect(quickstartCommands(kubernetesDraft()).at(-1)).toBe(
      'helm install platform-agent oci://ghcr.io/kodra-io/charts/kodra-agent --version 0.3.10 --namespace kodra-agent -f values.yaml --set-file config=kodra-agent.yaml',
    );
  });
});

describe('approval rules in the README', () => {
  it('states the effective rules for each environment', () => {
    const readme = file(
      generateBundle({
        ...kubernetesDraft(),
        profile: 'strict',
        policy: {
          approvers: 'U01, U02, U03',
          expiresAfterMinutes: '30',
          destructiveActions: 'deny',
        },
        environments: [
          { name: 'production', production: true, namespaces: 'api', repos: '', approvers: '' },
        ],
      }),
      'README.md',
    );
    expect(readme).toContain(
      'Profile: strict. For regulated, audited, or change-managed organizations.',
    );
    expect(readme).toContain(
      '- **production** (production; namespaces api): needs 2 different approvers from U01, U02, U03; the person who asked cannot approve it; expires after 30 minutes.',
    );
    expect(readme).toContain(
      '- **Everything else**: needs one approval from U01, U02, U03; the person who asked cannot approve it;',
    );
    expect(readme).toContain('A change that spans two environments is refused');
  });
});

describe('daily checks in the bundle', () => {
  it('says when they run, where the digest goes, and how to run them now', () => {
    const draft = composeDraft();
    expect(file(generateBundle(draft), 'README.md')).not.toContain('### Daily checks');
    draft.checks = { enabled: true, at: '08:30', days: 'weekdays', timezone: 'Asia/Amman' };
    const readme = file(generateBundle(draft), 'README.md');
    expect(readme).toContain('### Daily checks');
    expect(readme).toContain('At 08:30 (Asia/Amman), Monday to Friday, the agent checks');
    expect(readme).toContain(
      'It posts a digest to your Slack channel and shows it on the console Overview.',
    );
    expect(readme).toContain('docker compose run --rm kodra-agent check');
    expect(readme).toContain('the latest daily checks');
    const yaml = parse(file(generateBundle(draft), 'kodra-agent.yaml')) as {
      spec: { checks: unknown };
    };
    expect(yaml.spec.checks).toEqual({
      schedules: [
        {
          name: 'daily',
          at: '08:30',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          timezone: 'Asia/Amman',
        },
      ],
    });
  });

  it('runs them in the Deployment on Kubernetes', () => {
    const draft = kubernetesDraft();
    draft.checks = { enabled: true, at: '09:00', days: 'every-day', timezone: 'UTC' };
    expect(file(generateBundle(draft), 'README.md')).toContain(
      'exec deploy/platform-agent-kodra-agent -- node /app/apps/agent/src/bin.ts check',
    );
  });

  it('knows where the digest goes without Slack or the console', () => {
    const draft = composeDraft();
    expect(digestDestination(draft)).toBe('slack');
    delete draft.connectors['slack'];
    expect(digestDestination(draft)).toBe('console');
    draft.console.enabled = false;
    expect(digestDestination(draft)).toBe('log');
  });
});
