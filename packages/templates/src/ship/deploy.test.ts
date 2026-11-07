import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  deployTarget,
  detectStack,
  gitlabCi,
  githubWorkflow,
  IMAGES,
  jenkinsfile,
  knownHostsLine,
  planShip,
  shipPrBody,
  vmDeployScript,
  type DeploySpec,
  type DeployTarget,
  type RepoFiles,
} from './index.ts';

const repo = (files: Record<string, string>): RepoFiles => ({
  paths: Object.keys(files).sort(),
  read: (p) => files[p],
});

const POM = `<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent>
<properties><java.version>21</java.version></properties>
<dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
<dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency></dependencies></project>`;

const detection = () => {
  const r = detectStack(
    repo({ 'pom.xml': POM, 'src/test/java/AppTests.java': 'class AppTests {}' }),
    'acme/orders',
  );
  if (!r.ok) throw new Error(r.reason);
  return r.detection;
};

const KUBE: DeploySpec = {
  enabled: true,
  target: 'kubernetes',
  environment: 'staging',
  when: 'default-branch',
  credentials: 'KUBECONFIG_STAGING',
  namespace: 'shop',
};
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const VM: DeploySpec = {
  enabled: true,
  target: 'vm',
  environment: 'production',
  when: 'manual',
  credentials: 'VM_DEPLOY_KEY',
  host: 'app1.example.com',
  user: 'deploy',
  hostKey: HOST_KEY,
};

const ci = {
  image: 'ghcr.io/acme/orders',
  chartDir: 'charts/orders',
  defaultBranch: 'main',
  test: { image: IMAGES.maven[21], run: 'mvn -B test' },
};
const app = { name: 'orders', port: 8080, healthPath: '/actuator/health' };
const target = (spec: DeploySpec, system: 'jenkins' | 'github-actions' | 'gitlab-ci') => {
  const t = deployTarget(spec, system, app).target;
  if (!t) throw new Error('no target');
  return t;
};

describe('deployTarget (B6)', () => {
  it('is off unless enabled, and says why it cannot deploy', () => {
    expect(deployTarget(undefined, 'jenkins', app)).toEqual({ target: null, reason: null });
    expect(deployTarget({ ...KUBE, enabled: false }, 'jenkins', app).target).toBeNull();
    expect(deployTarget(KUBE, null, app).reason).toContain('No pipeline');
    expect(deployTarget({ ...KUBE, namespace: undefined }, 'jenkins', app).reason).toContain(
      'no namespace',
    );
    expect(deployTarget({ ...VM, hostKey: undefined }, 'jenkins', app).reason).toContain(
      'host key',
    );
    // A Jenkins ID may have dashes; a GitHub secret may not.
    expect(
      deployTarget({ ...KUBE, credentials: 'kube-staging' }, 'jenkins', app).target,
    ).not.toBeNull();
    expect(
      deployTarget({ ...KUBE, credentials: 'kube-staging' }, 'github-actions', app).reason,
    ).toContain('GitHub secret');
  });

  it('pins the VM host key with its host and port', () => {
    expect(knownHostsLine({ host: 'h', sshPort: 22 }, HOST_KEY)).toBe(`h ${HOST_KEY}`);
    expect(knownHostsLine({ host: 'h', sshPort: 2222 }, HOST_KEY)).toBe(`[h]:2222 ${HOST_KEY}`);
    expect(knownHostsLine({ host: 'h', sshPort: 22 }, `other ${HOST_KEY}`)).toBe(
      `other ${HOST_KEY}`,
    );
  });
});

describe('the deploy stage in each pipeline (B6)', () => {
  it('GitHub Actions: deploys merges only, after the image and chart, with the secret', () => {
    const doc = parse(githubWorkflow({ ...ci, deploy: target(KUBE, 'github-actions') })) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const deploy = doc.jobs['deploy'] as {
      needs: string[];
      if: string;
      environment: string;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      steps: { run?: string; env?: Record<string, string> }[];
    };
    expect(deploy.needs).toEqual(['image', 'chart']);
    expect(deploy.if).toBe("github.event_name == 'push'");
    expect(deploy.environment).toBe('staging');
    expect(deploy.concurrency).toEqual({ group: 'deploy-staging', 'cancel-in-progress': false });
    const step = deploy.steps[1];
    expect(step?.env?.['DEPLOY_CREDENTIALS']).toBe('${{ secrets.KUBECONFIG_STAGING }}');
    expect(step?.run).toContain('printf \'%s\\n\' "$DEPLOY_CREDENTIALS"');
    expect(step?.run).toContain(
      'helm upgrade --install orders charts/orders --namespace shop --set image.repository=$IMAGE --set image.tag=$SHA --rollback-on-failure --wait --timeout 5m',
    );
    expect(step?.run).toContain(IMAGES.helm);
  });

  it('GitHub Actions to a VM: SSH with the pinned host key, never skipping the check', () => {
    const text = githubWorkflow({ ...ci, deploy: target(VM, 'github-actions') });
    expect(text).toContain(
      'ssh -i "$RUNNER_TEMP/deploy_key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=deploy/known_hosts -p 22 deploy@app1.example.com sh -s -- "$IMAGE:$SHA" < deploy/vm-deploy.sh',
    );
    expect(text).not.toContain('StrictHostKeyChecking=no');
    expect(text).toContain('environment: production');
  });

  it('GitLab CI: a deploy stage on the default branch, manual when asked', () => {
    const auto = parse(gitlabCi({ ...ci, deploy: target(KUBE, 'gitlab-ci') })) as Record<
      string,
      unknown
    >;
    expect(auto['stages']).toEqual(['test', 'build', 'package', 'deploy']);
    const job = auto['deploy'] as {
      rules: { if: string; when: string }[];
      script: string[];
      resource_group: string;
      environment: { name: string };
    };
    expect(job.rules).toEqual([
      { if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH', when: 'on_success' },
    ]);
    expect(job.resource_group).toBe('deploy-staging');
    expect(job.script[0]).toBe('export KUBECONFIG="$KUBECONFIG_STAGING"');
    expect(job.script[1]).toContain('--set image.tag="$CI_COMMIT_SHA"');
    const manual = parse(
      gitlabCi({ ...ci, deploy: target({ ...KUBE, when: 'manual' }, 'gitlab-ci') }),
    ) as Record<string, { rules: { when: string }[] }>;
    expect(manual['deploy']?.rules[0]?.when).toBe('manual');
    const vm = parse(gitlabCi({ ...ci, deploy: target(VM, 'gitlab-ci') })) as Record<
      string,
      { image: { name: string }; script: string[] }
    >;
    expect(vm['deploy']?.image.name).toBe(IMAGES.ssh);
    expect(vm['deploy']?.script[0]).toBe('chmod 600 "$VM_DEPLOY_KEY"');
  });

  it('Jenkins: the default branch only, the credential by ID, and an input step when manual', () => {
    const auto = jenkinsfile({
      ...ci,
      deploy: target({ ...KUBE, credentials: 'kube-staging' }, 'jenkins'),
    });
    expect(auto).toContain("stage('Deploy')");
    expect(auto).toContain("branch 'main'");
    expect(auto).toContain("file(credentialsId: 'kube-staging', variable: 'DEPLOY_FILE')");
    expect(auto).toContain('${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"}');
    expect(auto).toContain('docker cp "$DEPLOY_FILE" "$cid:/tmp/deploy"');
    expect(auto).toContain('--set image.tag=$sha');
    expect(auto).not.toContain('input {');
    // Groovy reads backslashes in ''' strings: there are none.
    expect(auto).not.toContain('\\');

    const manual = jenkinsfile({ ...ci, deploy: target(VM, 'jenkins') });
    expect(manual).toContain("message 'Deploy to production?'");
    expect(manual).toContain('beforeInput true');
    expect(manual).toContain(
      "sshUserPrivateKey(credentialsId: 'VM_DEPLOY_KEY', keyFileVariable: 'DEPLOY_FILE')",
    );
    expect(manual).toContain("timeout(time: 90, unit: 'MINUTES')");
    expect(manual).not.toContain('\\');
  });

  it('pipelines without a deploy target have no deploy stage', () => {
    expect(githubWorkflow(ci)).not.toContain('deploy:');
    expect(gitlabCi(ci)).not.toContain('deploy');
    expect(jenkinsfile(ci)).not.toContain("stage('Deploy')");
  });
});

describe('the VM deploy script (B6)', () => {
  const vm = target(VM, 'jenkins') as Extract<DeployTarget, { kind: 'vm' }>;

  it('replaces the container, waits for health, and puts the previous image back', () => {
    const script = vmDeployScript(vm);
    expect(script).toContain('set -eu');
    expect(script).toContain('health="http://127.0.0.1:$port/actuator/health"');
    expect(script).toContain('docker pull "$image"');
    expect(script).toContain('--env-file "/etc/$name.env"');
    expect(script).toContain('start "$previous"');
    expect(script).toContain('curl -fsS');
    expect(script).toMatch(/exit 1\n$/);
  });

  it('counts any answer when the app has no health endpoint', () => {
    expect(vmDeployScript({ ...vm, healthPath: null })).not.toContain('curl -fsS');
  });
});

describe('planShip with a deploy stage (B6)', () => {
  it('adds the deployer RBAC and says what to set up, for Kubernetes', () => {
    const plan = planShip(detection(), {
      provider: 'github',
      repo: 'acme/orders',
      defaultBranch: 'main',
      deploy: KUBE,
    });
    expect(plan.deploy.target).toMatchObject({
      kind: 'kubernetes',
      namespace: 'shop',
      release: 'orders',
    });
    const rbac = plan.files.find((f) => f.path === 'deploy/ci-deployer-rbac.yaml');
    const docs = parse(rbac?.content.split('---')[1] ?? '') as {
      kind: string;
      metadata: { namespace: string };
    };
    expect(docs).toMatchObject({ kind: 'Role', metadata: { namespace: 'shop' } });
    expect(rbac?.content).not.toContain('ClusterRole');
    const workflow = plan.files.find((f) => f.path === '.github/workflows/container.yml');
    expect(workflow?.content).toContain('Deploy to staging');
    expect(workflow?.reason).toContain('Deploys to namespace `shop` from main.');
    const body = shipPrBody({ detection: detection(), plan, verification: [], modelChanges: [] });
    expect(body).toContain('## Deploy');
    expect(body).toContain('a GitHub Actions secret `KUBECONFIG_STAGING`');
    expect(body).toContain('The agent holds no deploy credentials');
    expect(body).toContain('Nothing is deployed until it is merged');
  });

  it('adds the VM script and the pinned host key for a VM', () => {
    const plan = planShip(detection(), {
      provider: 'github',
      repo: 'acme/orders',
      defaultBranch: 'main',
      ci: { ci: 'jenkins', reason: 'x' },
      deploy: VM,
    });
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['Jenkinsfile', 'deploy/vm-deploy.sh', 'deploy/known_hosts']),
    );
    expect(plan.files.find((f) => f.path === 'deploy/known_hosts')?.content).toBe(
      `app1.example.com ${HOST_KEY}\n`,
    );
    const body = shipPrBody({ detection: detection(), plan, verification: [], modelChanges: [] });
    expect(body).toContain('SSH Username with private key with the ID `VM_DEPLOY_KEY`');
    expect(body).toContain('waits for a person to press Deploy in Jenkins');
  });

  it("keeps the team's own pipeline and says no deploy stage was added", () => {
    const d = { ...detection(), existing: { ...detection().existing, githubCi: true } };
    const plan = planShip(d, {
      provider: 'github',
      repo: 'acme/orders',
      defaultBranch: 'main',
      deploy: KUBE,
    });
    expect(plan.deploy.target).toBeNull();
    expect(plan.deploy.reason).toContain('existing pipeline is kept');
    expect(plan.files.some((f) => f.path.startsWith('deploy/'))).toBe(false);
  });
});
