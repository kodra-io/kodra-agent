import { getConnector, getModelProvider } from '@kodra-agent/connectors';
import type { AccessLevel, LocalizedText, Manifest, SecretSpec } from '@kodra-agent/schema';
import { configYaml, includedSecrets, secretRefFor } from './config.ts';
import { enabledConnectors, splitList, type AgentDraft } from './draft.ts';

/** The published image and chart. A test checks these against the chart and the agent version. */
export const AGENT_IMAGE = 'ghcr.io/kodra-io/kodra-agent';
export const AGENT_VERSION = '0.1.1';
export const AGENT_CHART = 'oci://ghcr.io/kodra-io/charts/kodra-agent';
export const AGENT_NAMESPACE = 'kodra-agent';
const CONFIG_PATH = '/etc/kodra-agent/kodra-agent.yaml';

export interface BundleFile {
  path: string;
  content: string;
}

export interface Bundle {
  /** Folder name inside the zip, and the zip's base name. */
  root: string;
  files: BundleFile[];
}

interface SecretUse {
  owner: string;
  spec: SecretSpec;
  access?: AccessLevel | undefined;
}

const q = (value: string) => JSON.stringify(value);

function agentName(draft: AgentDraft): string {
  return draft.name.trim() || 'my-agent';
}

function secretsInUse(draft: AgentDraft): SecretUse[] {
  const uses: SecretUse[] = [];
  const provider = getModelProvider(draft.model.provider);
  for (const spec of provider?.secrets ?? [])
    uses.push({ owner: provider?.displayName ?? '', spec });
  for (const manifest of enabledConnectors(draft)) {
    const entry = draft.connectors[manifest.id];
    for (const spec of includedSecrets(manifest, entry?.optionalSecrets ?? [], draft.target)) {
      uses.push({ owner: manifest.displayName, spec, access: entry?.access });
    }
  }
  return uses;
}

function scopesFor(use: SecretUse): string[] {
  const scopes = use.spec.minimumScopes;
  return [...(scopes.always ?? []), ...((use.access && scopes[use.access]) ?? [])];
}

/** The Docker socket is mounted only for build access on the compose target (SPEC section 9). */
export function dockerSocketPath(draft: AgentDraft): string | null {
  const docker = draft.connectors['docker'];
  if (draft.target !== 'compose' || docker?.enabled !== true) return null;
  if (docker.access !== 'read-write-approved') return null;
  return docker.config['socketPath']?.trim() || '/var/run/docker.sock';
}

/** `init` for EKS: also mounts ~/.aws read-only and passes AWS_PROFILE, for `aws eks get-token`. */
const EKS_INIT_COMMAND = `docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -e AWS_PROFILE -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$HOME/.aws:/home/kodra/.aws:ro" -v "$PWD:/work" -w /work ${AGENT_IMAGE}:${AGENT_VERSION} init --target kubernetes --namespace ${AGENT_NAMESPACE}`;

export function quickstartCommands(draft: AgentDraft): string[] {
  const name = agentName(draft);
  if (draft.target === 'compose') {
    return ['docker compose run --rm kodra-agent init', 'docker compose up -d'];
  }
  const hasRbac = draft.connectors['kubernetes']?.enabled === true;
  return [
    `kubectl create namespace ${AGENT_NAMESPACE}`,
    ...(hasRbac ? ['kubectl apply -f rbac.yaml'] : []),
    // Runs init from the image, so nobody needs the CLI installed locally.
    // Runs as you, so it can read your kubeconfig (usually readable by its owner only).
    `docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/kodra -v "$HOME/.kube:/home/kodra/.kube:ro" -v "$PWD:/work" -w /work ${AGENT_IMAGE}:${AGENT_VERSION} init --target kubernetes --namespace ${AGENT_NAMESPACE}`,
    `helm install ${name} ${AGENT_CHART} --version ${AGENT_VERSION} --namespace ${AGENT_NAMESPACE} -f values.yaml --set-file config=kodra-agent.yaml`,
  ];
}

function envExample(draft: AgentDraft): string {
  const lines = [
    `# Environment for ${agentName(draft)}.`,
    '# Run `kodra-agent init` to fill this in: it asks for each value with hidden input,',
    '# checks it with a read-only call, and writes .env with owner-only permissions.',
    '# Never commit .env.',
  ];
  const uses = secretsInUse(draft);
  for (const use of uses.filter((u) => u.spec.defaultRef === 'env')) {
    lines.push('', `# ${use.owner}: ${use.spec.description.en}`);
    lines.push(`# How to create: ${use.spec.howToCreate.en}`);
    const scopes = scopesFor(use);
    if (scopes.length > 0) lines.push(`# Minimum access: ${scopes.join('; ')}`);
    lines.push(`${use.spec.envVar}=`);
  }
  const files = uses.filter((u) => u.spec.defaultRef === 'file');
  if (files.length > 0) {
    lines.push('', '# Files, not environment variables:');
    for (const use of files) {
      const path = secretRefFor(use.spec).slice('${file:'.length, -1);
      lines.push(
        draft.target === 'compose'
          ? `#   ${use.owner} ${use.spec.key}: put it at .${path} (mounted read-only at ${path}).`
          : `#   ${use.owner} ${use.spec.key}: \`kodra-agent init\` stores it in the agent's Secret.`,
      );
    }
  }
  if (draft.model.provider === 'bedrock' || draft.connectors['aws']?.enabled === true) {
    lines.push(
      '',
      '# AWS: without AWS keys here, the agent uses the standard AWS credentials (for example an IAM role).',
    );
  }
  return `${lines.join('\n')}\n`;
}

const GITIGNORE = `# Secrets stay on this machine.
.env
.env.*
!.env.example
secrets/
`;

function hasFileSecrets(draft: AgentDraft): boolean {
  return secretsInUse(draft).some((u) => u.spec.defaultRef === 'file');
}

function composeYaml(draft: AgentDraft): string {
  const socket = dockerSocketPath(draft);
  const volumes = [
    '      # The bundle folder: kodra-agent.yaml, and .env written by `init`.',
    '      - ./:/etc/kodra-agent',
    '      - kodra-agent-data:/var/lib/kodra-agent',
  ];
  if (hasFileSecrets(draft)) volumes.push('      - ./secrets:/secrets:ro');
  if (socket) {
    volumes.push(
      '      # WARNING: the Docker socket gives near-root control of this machine.',
      '      # It is mounted only because the Docker connector has build access.',
      `      - ${q(`${socket}:/var/run/docker.sock`)}`,
    );
  }
  return `# Docker Compose for ${agentName(draft)} (Kodra AI Agent ${AGENT_VERSION}).
services:
  kodra-agent:
    image: ${AGENT_IMAGE}:${AGENT_VERSION}
    command: ["run"]
    # On Linux, the README has you set KODRA_AGENT_USER in .env to your own user, so the
    # agent can write .env and read secrets/ in this folder.
    user: "\${KODRA_AGENT_USER:-10001:10001}"
    working_dir: /etc/kodra-agent
    environment:
      KODRA_AGENT_CONFIG: ${CONFIG_PATH}
    env_file:
      - path: .env
        required: false
    volumes:
${volumes.join('\n')}
${
  socket
    ? `    # The Docker socket's group: 0 on Docker Desktop; on Linux the README sets KODRA_DOCKER_GID.
    group_add: ["\${KODRA_DOCKER_GID:-0}"]
`
    : ''
}    read_only: true
    tmpfs: ["/tmp"]
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    restart: unless-stopped

volumes:
  kodra-agent-data: {}
`;
}

function valuesYaml(draft: AgentDraft): string {
  const name = agentName(draft);
  const files = secretsInUse(draft).filter((u) => u.spec.defaultRef === 'file');
  const fileSecrets =
    files.length === 0
      ? 'fileSecrets: []'
      : `fileSecrets:\n${files
          .map(
            (u) =>
              `  - key: ${q(u.spec.key)}\n    mountPath: ${q(secretRefFor(u.spec).slice(7, -1))}`,
          )
          .join('\n')}`;
  return `# Helm values for ${name} (Kodra AI Agent ${AGENT_VERSION}).
# The agent config is passed with --set-file config=kodra-agent.yaml, so it lives in one place.
image:
  repository: ${AGENT_IMAGE}
  tag: ${q(AGENT_VERSION)}

# Created by \`kodra-agent init --target kubernetes\`. Secret values never go in this file.
existingSecret: ${q(`${name}-secrets`)}
# Secrets referenced as files in kodra-agent.yaml, mounted from that Secret.
${fileSecrets}

serviceAccount:
  name: ${q(name)}

# rbac.yaml in this bundle grants namespace access. Review it and apply it yourself.
rbac:
  create: false

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    memory: 512Mi
`;
}

const READ_RULES = `  - apiGroups: [""]
    resources: ["pods", "pods/log", "events", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]`;

const WRITE_RULES = `  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale"]
    verbs: ["patch"]`;

/** Namespace-scoped, least-privilege RBAC for the Kubernetes connector. */
export function rbacYaml(draft: AgentDraft): string | null {
  const k8s = draft.connectors['kubernetes'];
  if (draft.target !== 'kubernetes' || k8s?.enabled !== true) return null;
  const name = agentName(draft);
  const namespaces = splitList(k8s.config['namespaces'] ?? '');
  const rules = k8s.access === 'read-write-approved' ? `${READ_RULES}\n${WRITE_RULES}` : READ_RULES;
  const docs = namespaces.map(
    (ns) => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${q(name)}
  namespace: ${q(ns)}
rules:
${rules}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${q(name)}
  namespace: ${q(ns)}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${q(name)}
subjects:
  - kind: ServiceAccount
    name: ${q(name)}
    namespace: ${AGENT_NAMESPACE}`,
  );
  return `# Least-privilege access for ${name}: one Role per namespace, nothing cluster-wide.
# Access level: ${k8s.access}.
${docs.join('\n---\n')}
`;
}

function summaryLines(manifest: Manifest, access: AccessLevel | undefined): LocalizedText[] {
  const s = manifest.permissionsSummary;
  return [...(s.always ?? []), ...((access && s[access]) ?? [])];
}

/**
 * A Slack app manifest: Socket Mode, buttons, mentions and DMs, and exactly the bot scopes
 * the Slack connector manifest lists, so the two cannot drift apart.
 */
export function slackAppManifest(draft: AgentDraft): string | null {
  if (draft.connectors['slack']?.enabled !== true) return null;
  const bot = getConnector('slack')?.secrets.find((s) => s.key === 'botToken');
  const scopes = bot?.minimumScopes.always ?? [];
  const name = `Kodra AI Agent (${agentName(draft)})`.slice(0, 35);
  return `# Create the app at https://api.slack.com/apps > Create New App > From an app manifest.
display_information:
  name: ${q(name)}
  description: "Self-hosted DevOps agent. Asks an approver before any change."
features:
  bot_user:
    display_name: ${q(agentName(draft).slice(0, 80))}
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
${scopes.map((s) => `      - ${q(s)}`).join('\n')}
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
  event_subscriptions:
    bot_events:
      - "app_mention"
      - "message.im"
`;
}

function readme(draft: AgentDraft): string {
  const name = agentName(draft);
  const provider = getModelProvider(draft.model.provider);
  const lines: string[] = [
    `# ${name}`,
    '',
    `A [Kodra AI Agent](https://github.com/kodra-io/kodra-agent) configuration (${AGENT_VERSION}).`,
    '',
    '> Pre-release: the agent image and Helm chart are published from the first release.',
    '',
    '## Quickstart',
    '',
    ...(draft.target === 'compose'
      ? [
          dockerSocketPath(draft)
            ? 'On Linux, run these first, so the agent runs as you, can write `.env` in this folder, and can use the Docker socket:'
            : 'On Linux, run this first, so the agent runs as you and can write `.env` in this folder:',
          '',
          '```sh',
          'echo "KODRA_AGENT_USER=$(id -u):$(id -g)" >> .env',
          ...(dockerSocketPath(draft)
            ? ['echo "KODRA_DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env']
            : []),
          '```',
          '',
          'Then, in this folder:',
          '',
        ]
      : []),
  ];
  quickstartCommands(draft).forEach((cmd, i) => {
    lines.push(`${i + 1}. \`${cmd}\``);
  });
  lines.push(
    '',
    draft.target === 'compose'
      ? [
          '`init` asks for each secret with hidden input, checks it, and writes `.env` (owner-only). Never commit `.env`.',
          ...(draft.connectors['kubernetes']?.enabled === true
            ? [
                '',
                'EKS: if your kubeconfig runs `aws eks get-token`, the agent uses its own built-in version, with',
                'the AWS credentials in `.env` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) or',
                "the machine's IAM role.",
              ]
            : []),
        ].join('\n')
      : [
          '`init` asks for each secret with hidden input, checks it, and stores it in a Kubernetes Secret.',
          '',
          '### EKS clusters',
          '',
          'A kubeconfig from `aws eks update-kubeconfig` runs `aws eks get-token` for each connection.',
          'The agent image has its own `aws eks get-token` (it is not the full AWS CLI), so give `init`',
          'your AWS settings too, read-only. With AWS SSO, run `aws sso login` first.',
          '',
          '```sh',
          EKS_INIT_COMMAND,
          '```',
          '',
          "Other login helpers, like GKE's `gke-gcloud-auth-plugin`, are not in the image. For those, add",
          '`--dry-run` to the `init` command: it prints the Secret with placeholders and the',
          '`kubectl create secret` command to fill it in yourself.',
        ].join('\n'),
    '',
  );
  if (draft.connectors['slack']?.enabled === true) {
    lines.push(
      '### Slack app',
      '',
      'Before `init`: at api.slack.com/apps, choose **Create New App > From an app manifest**, paste',
      '`slack-app-manifest.yaml`, and install the app. Then, under **Basic Information > App-Level',
      'Tokens**, create a token with `connections:write`. `init` asks for both tokens. Invite the app',
      'to your channel with `/invite @<app name>`.',
      '',
    );
  }
  lines.push('## What this agent can do', '');
  if (provider) {
    lines.push(`**Model: ${provider.displayName}**`, '');
    for (const t of summaryLines(provider, undefined)) lines.push(`- ${t.en}`);
    lines.push('');
  }
  for (const manifest of enabledConnectors(draft)) {
    const access = draft.connectors[manifest.id]?.access;
    const label = manifest.accessLevels.length > 0 ? ` (${access ?? 'read-only'})` : '';
    lines.push(`**${manifest.displayName}${label}**`, '');
    for (const t of summaryLines(manifest, manifest.accessLevels.length > 0 ? access : undefined)) {
      lines.push(`- ${t.en}`);
    }
    lines.push('');
  }
  const approvers = splitList(draft.policy.approvers).join(', ') || '(none set)';
  lines.push(
    '## Approvals',
    '',
    `- Every write action needs approval from: ${approvers}.`,
    `- Approval requests expire after ${draft.policy.expiresAfterMinutes.trim()} minutes.`,
    draft.policy.destructiveActions === 'deny'
      ? '- Destructive actions are blocked.'
      : '- Destructive actions are blocked unless approved.',
    '- Everything the agent does is written to an audit log in your environment.',
    '',
    '## Secrets the setup asks for',
    '',
  );
  const uses = secretsInUse(draft);
  if (uses.length === 0) lines.push('None.');
  for (const use of uses) {
    const where =
      use.spec.defaultRef === 'env' ? `\`${use.spec.envVar}\`` : `a file (${use.spec.key})`;
    lines.push(`- ${use.owner}: ${where}. ${use.spec.description.en}`);
  }
  if (dockerSocketPath(draft)) {
    lines.push(
      '',
      '## Docker socket warning',
      '',
      'This bundle mounts the Docker socket because the Docker connector has build access.',
      'Access to the Docker socket is close to full control of this machine. Run this agent',
      'only on a machine meant for builds, and turn build access off if you do not need it.',
      '',
      '## Ship a service',
      '',
      'With build access, the agent can add a Dockerfile, CI, and a Helm chart to a repo, build and',
      'test the image, and open a pull request after you approve:',
      '',
      '```sh',
      'docker compose run --rm kodra-agent ship <owner/repo>',
      '```',
    );
  }
  lines.push('', '## Uninstall', '');
  if (draft.target === 'compose') {
    lines.push(
      '1. `docker compose down -v` (stops the agent and deletes its audit log volume)',
      '2. Delete `.env` and the `secrets/` folder.',
      '3. Revoke the tokens listed above in each service.',
    );
  } else {
    lines.push(
      `1. \`helm uninstall ${name} --namespace ${AGENT_NAMESPACE}\``,
      ...(rbacYaml(draft) ? ['2. `kubectl delete -f rbac.yaml`'] : []),
      `${rbacYaml(draft) ? 3 : 2}. \`kubectl delete secret ${name}-secrets --namespace ${AGENT_NAMESPACE}\``,
      `${rbacYaml(draft) ? 4 : 3}. Revoke the tokens listed above in each service.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Every file in the downloadable bundle, generated without any network access. */
export function generateBundle(draft: AgentDraft): Bundle {
  const files: BundleFile[] = [
    { path: 'kodra-agent.yaml', content: configYaml(draft) },
    { path: '.env.example', content: envExample(draft) },
    { path: '.gitignore', content: GITIGNORE },
  ];
  if (draft.target === 'compose') {
    files.push({ path: 'docker-compose.yml', content: composeYaml(draft) });
  } else {
    files.push({ path: 'values.yaml', content: valuesYaml(draft) });
    const rbac = rbacYaml(draft);
    if (rbac) files.push({ path: 'rbac.yaml', content: rbac });
  }
  const slackManifest = slackAppManifest(draft);
  if (slackManifest) files.push({ path: 'slack-app-manifest.yaml', content: slackManifest });
  files.push({ path: 'README.md', content: readme(draft) });
  return { root: `kodra-agent-${agentName(draft)}`, files };
}
