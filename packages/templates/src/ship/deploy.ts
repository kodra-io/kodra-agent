import type { CiSystem } from './ci-system.ts';
import { IMAGES } from './images.ts';

/**
 * The deploy stage (B6): the team's own pipeline deploys, after the tests, the image, and the
 * chart check pass on the default branch. The agent never holds the deploy credentials: the
 * pipeline reads them from the CI system's own secret store, by the name in `credentials`.
 */
export interface DeploySpec {
  enabled: boolean;
  /** Where it deploys: a Kubernetes namespace with Helm, or a VM with Docker over SSH. */
  target: 'kubernetes' | 'vm';
  /** The environment's name, shown in the CI system (GitHub and GitLab environments). */
  environment: string;
  /** `default-branch` deploys every merge; `manual` waits for a person in the CI system. */
  when: 'default-branch' | 'manual';
  /**
   * The CI secret holding a kubeconfig (Kubernetes) or an SSH private key (VM): a Jenkins
   * credentials ID, a GitHub Actions secret, or a GitLab CI/CD variable of type File.
   */
  credentials: string;
  /** Kubernetes: the namespace the release goes to. */
  namespace?: string | undefined;
  /** VM: the host, the SSH user and port, and the host's public key line (known_hosts). */
  host?: string | undefined;
  user?: string | undefined;
  sshPort?: number | undefined;
  hostKey?: string | undefined;
}

export type DeployTarget =
  | {
      kind: 'kubernetes';
      environment: string;
      when: DeploySpec['when'];
      credentials: string;
      namespace: string;
      release: string;
    }
  | {
      kind: 'vm';
      environment: string;
      when: DeploySpec['when'];
      credentials: string;
      host: string;
      user: string;
      sshPort: number;
      container: string;
      port: number;
      /** Null: the app has no health endpoint, so any HTTP answer counts. */
      healthPath: string | null;
    };

export const VM_SCRIPT = 'deploy/vm-deploy.sh';
export const KNOWN_HOSTS = 'deploy/known_hosts';
export const DEPLOYER_RBAC = 'deploy/ci-deployer-rbac.yaml';

/** GitHub secret names and GitLab variable names; Jenkins IDs may also have `.` and `-`. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The deploy target for this repo and CI, or why there is none. */
export function deployTarget(
  spec: DeploySpec | undefined,
  ci: CiSystem | null,
  app: { name: string; port: number; healthPath: string | null },
): { target: DeployTarget | null; reason: string | null } {
  if (!spec?.enabled) return { target: null, reason: null };
  if (!ci)
    return { target: null, reason: 'No pipeline is generated here, so it has no deploy stage.' };
  if (ci !== 'jenkins' && !ENV_NAME.test(spec.credentials)) {
    return {
      target: null,
      reason: `\`${spec.credentials}\` cannot be a ${ci === 'github-actions' ? 'GitHub secret' : 'GitLab variable'} name: use letters, digits, and underscores.`,
    };
  }
  const base = { environment: spec.environment, when: spec.when, credentials: spec.credentials };
  if (spec.target === 'kubernetes') {
    if (!spec.namespace) return { target: null, reason: 'The deploy target has no namespace.' };
    return {
      target: { kind: 'kubernetes', ...base, namespace: spec.namespace, release: app.name },
      reason: null,
    };
  }
  if (!spec.host || !spec.user || !spec.hostKey) {
    return { target: null, reason: 'The VM target needs its host, user, and host key.' };
  }
  return {
    target: {
      kind: 'vm',
      ...base,
      host: spec.host,
      user: spec.user,
      sshPort: spec.sshPort ?? 22,
      container: app.name,
      port: app.port,
      healthPath: app.healthPath,
    },
    reason: null,
  };
}

/**
 * Helm upgrade with the commit's image, waiting for the rollout and rolling back on failure
 * (Helm 4 flags). `sha` is a shell expression for the commit, expanded by the calling shell.
 */
export function helmDeployCommand(
  t: Extract<DeployTarget, { kind: 'kubernetes' }>,
  chartDir: string,
  image: string,
  sha: string,
): string {
  return [
    `helm upgrade --install ${t.release} ${chartDir}`,
    `--namespace ${t.namespace}`,
    `--set image.repository=${image}`,
    `--set image.tag=${sha}`,
    '--rollback-on-failure --wait --timeout 5m --history-max 10',
    `&& helm status ${t.release} --namespace ${t.namespace}`,
  ].join(' ');
}

/** The SSH command that runs the VM script with the image to deploy as its argument. */
export function sshDeployCommand(
  t: Extract<DeployTarget, { kind: 'vm' }>,
  key: string,
  knownHosts: string,
  script: string,
  imageRef: string,
): string {
  return `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} -p ${String(t.sshPort)} ${t.user}@${t.host} sh -s -- ${imageRef} < ${script}`;
}

/**
 * Runs on the VM: pulls the image, replaces the container, waits for its health check, and
 * puts the previous image back if the new one never gets healthy. Settings and secrets come
 * from an env file on the VM, never from the pipeline.
 */
export function vmDeployScript(t: Extract<DeployTarget, { kind: 'vm' }>): string {
  return `#!/bin/sh
# Generated by Kodra AI Agent. Runs on ${t.host} over SSH: sh -s -- <image> < ${VM_SCRIPT}
# Settings and secrets for the app go in /etc/${t.container}.env on the VM (one NAME=value
# per line); the pipeline never carries them. The VM must be able to pull the image.
set -eu
image="$1"
name="${t.container}"
port="${String(t.port)}"
health="http://127.0.0.1:$port${t.healthPath ?? '/'}"

previous=$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null || true)
docker pull "$image"

start() {
  docker rm -f "$name" > /dev/null 2>&1 || true
  if [ -f "/etc/$name.env" ]; then
    docker run -d --name "$name" --restart unless-stopped --env-file "/etc/$name.env" -p "$port:$port" "$1" > /dev/null
  else
    docker run -d --name "$name" --restart unless-stopped -p "$port:$port" "$1" > /dev/null
  fi
}

healthy() {
${
  t.healthPath
    ? '  curl -fsS -o /dev/null "$health" 2>/dev/null || wget -q -O /dev/null "$health" 2>/dev/null'
    : '  # No health endpoint: any HTTP answer counts.\n  curl -sS -o /dev/null "$health" 2>/dev/null || wget -q -O /dev/null "$health" 2>/dev/null'
}
}

start "$image"
for _ in $(seq 1 45); do
  if healthy; then
    echo "Deployed $image: $health answers."
    exit 0
  fi
  sleep 2
done
echo "$image did not get healthy in 90 seconds. Its last log lines:"
docker logs --tail 50 "$name" 2>&1 || true
if [ -n "$previous" ] && [ "$previous" != "$image" ]; then
  start "$previous"
  echo "Rolled back to $previous."
fi
exit 1
`;
}

/**
 * A ServiceAccount the pipeline deploys with, limited to its namespace: what the chart
 * creates, plus Secrets because Helm keeps its release history in them.
 */
export function deployerRbac(t: Extract<DeployTarget, { kind: 'kubernetes' }>): string {
  return `# Generated by Kodra AI Agent. Apply once, by a cluster admin:
#   kubectl apply -f ${DEPLOYER_RBAC}
# Then make a kubeconfig for this ServiceAccount (see the pull request) and store it in your
# CI system as \`${t.credentials}\`. It can deploy to ${t.namespace} and nowhere else.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: ${t.namespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ci-deployer
  namespace: ${t.namespace}
rules:
  - apiGroups: [""]
    resources: [services, configmaps, secrets, serviceaccounts]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [""]
    resources: [pods, pods/log, events, endpoints]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, replicasets]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list, watch, create, update, patch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer
  namespace: ${t.namespace}
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: ${t.namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ci-deployer
`;
}

/** A known_hosts line: the key as given (`ssh-ed25519 AAAA...`) with the host in front. */
export function knownHostsLine(t: { host: string; sshPort: number }, hostKey: string): string {
  const key = hostKey.trim();
  // Already a known_hosts line (the host first).
  if (!/^(ssh-|ecdsa-|sk-)/.test(key)) return key;
  const host = t.sshPort === 22 ? t.host : `[${t.host}]:${String(t.sshPort)}`;
  return `${host} ${key}`;
}

/** Files the deploy stage needs besides the pipeline. */
export function deployFiles(
  t: DeployTarget,
  hostKey: string | undefined,
): { path: string; content: string; reason: string }[] {
  if (t.kind === 'kubernetes') {
    return [
      {
        path: DEPLOYER_RBAC,
        content: deployerRbac(t),
        reason: `A ServiceAccount for the pipeline that can deploy to \`${t.namespace}\` only. A cluster admin applies it once.`,
      },
    ];
  }
  return [
    {
      path: VM_SCRIPT,
      content: vmDeployScript(t),
      reason: `Runs on ${t.host} over SSH: pulls the image, replaces the container, waits for the health check, and puts the previous image back if it fails.`,
    },
    {
      path: KNOWN_HOSTS,
      content: `${knownHostsLine(t, hostKey ?? '')}\n`,
      reason: `The pinned SSH host key of ${t.host}, so the pipeline never connects to a host it does not know.`,
    },
  ];
}

/** What the team adds to its CI system before the first deploy, for the PR description. */
export function deploySection(
  t: DeployTarget,
  ci: CiSystem,
  chartDir: string,
  image: string,
): string[] {
  const where = t.kind === 'kubernetes' ? `namespace \`${t.namespace}\`` : `\`${t.host}\``;
  const trigger =
    t.when === 'manual'
      ? 'after a person approves it in the CI system'
      : `on every merge to the default branch`;
  const store =
    ci === 'jenkins'
      ? t.kind === 'kubernetes'
        ? `a Jenkins credential of kind Secret file with the ID \`${t.credentials}\``
        : `a Jenkins credential of kind SSH Username with private key with the ID \`${t.credentials}\``
      : ci === 'github-actions'
        ? `a GitHub Actions secret \`${t.credentials}\`${t.environment ? ` (repository or \`${t.environment}\` environment)` : ''}, holding the whole file`
        : `a GitLab CI/CD variable \`${t.credentials}\` of type File, protected`;
  const lines = [
    '## Deploy',
    `The pipeline deploys to ${where} (environment \`${t.environment}\`) ${trigger}, only after the tests, the image, and the chart check pass. The agent holds no deploy credentials: the pipeline reads them from your CI system.`,
    t.kind === 'kubernetes'
      ? `It runs \`helm upgrade --install\` with the commit's image tag, waits for the rollout, and rolls back by itself if the rollout fails.`
      : `It runs \`${VM_SCRIPT}\` on the VM over SSH, checking the host key in \`${KNOWN_HOSTS}\`. If the new container does not get healthy, the script puts the previous image back.`,
    '',
    'Before the first deploy:',
  ];
  if (t.kind === 'kubernetes') {
    lines.push(
      `1. A cluster admin applies \`${DEPLOYER_RBAC}\`: a ServiceAccount that can deploy to \`${t.namespace}\` only.`,
      `2. Make a kubeconfig for it (\`kubectl create token ci-deployer -n ${t.namespace} --duration=8760h\`, or better a short-lived token from your cloud's OIDC federation) and store it as ${store}.`,
      `3. The cluster can pull \`${image}\` (add an image pull secret to the chart's values if the registry is private), and the CI runner can reach the cluster's API server.`,
    );
    if (ci === 'jenkins') {
      lines.push(
        '4. If the API server is reached through a Docker network (kind, for example), set the environment variable `DOCKER_NETWORK` to it on the Jenkins agent.',
      );
    }
  } else {
    lines.push(
      `1. Create the user \`${t.user}\` on \`${t.host}\` with Docker access, and add the public half of a new SSH key to its \`authorized_keys\`.`,
      `2. Store the private key as ${store}.`,
      `3. The VM can pull \`${image}\` (\`docker login\` once on the VM if the registry is private), and its settings go in \`/etc/${t.container}.env\`.`,
    );
  }
  if (t.when === 'manual') {
    lines.push(
      ci === 'github-actions'
        ? `- In Settings, Environments, give \`${t.environment}\` required reviewers: the deploy job waits for them.`
        : ci === 'gitlab-ci'
          ? '- The deploy job is manual: press play on it in the pipeline. Protect the environment to choose who may.'
          : '- The Deploy stage waits for a person to press Deploy in Jenkins.',
    );
  }
  lines.push(
    `- The chart in \`${chartDir}\` is what gets deployed: change it there, through pull requests.`,
  );
  return lines;
}

/** Shared by the renderers: the network a Jenkins helper container joins, when set. */
export const JENKINS_NETWORK = '${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"}';

export const SSH_IMAGE = IMAGES.ssh;
