import { describe, expect, it } from 'vitest';
import {
  chooseCi,
  detectStack,
  jenkinsfile,
  planShip,
  shipPrBody,
  type CiChoiceInput,
  type Detection,
} from './index.ts';

const NONE = { githubCi: false, gitlabCi: false, jenkinsfile: false };
const choose = (i: Partial<CiChoiceInput>) =>
  chooseCi({ setting: 'auto', provider: 'github', existing: NONE, connected: [], ...i });

const spring = (): Detection => {
  const pom =
    '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>21</java.version></properties><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>spring-boot-starter-test</artifactId></dependency></dependencies></project>';
  const files: Record<string, string> = {
    'pom.xml': pom,
    'src/test/java/AppTest.java': 'class AppTest {}',
  };
  const r = detectStack({ paths: Object.keys(files), read: (p) => files[p] }, 'kodra-io/demo-app');
  if (!r.ok) throw new Error(r.reason);
  return r.detection;
};

describe('chooseCi', () => {
  it('uses the CI connector that is turned on, whatever hosts the repo', () => {
    expect(choose({ connected: ['jenkins'] })).toEqual({
      ci: 'jenkins',
      reason: 'Jenkins is the CI connector that is turned on.',
    });
    expect(choose({ provider: 'gitlab', connected: ['jenkins'] }).ci).toBe('jenkins');
    expect(choose({ provider: null, connected: ['jenkins'] }).ci).toBe('jenkins');
  });

  it("falls back to the host's own CI, and to none for a local folder", () => {
    expect(choose({}).ci).toBe('github-actions');
    expect(choose({ provider: 'gitlab' }).ci).toBe('gitlab-ci');
    expect(choose({ provider: null })).toEqual({
      ci: null,
      reason: 'No CI connector is turned on, so no pipeline is written.',
    });
  });

  it('ignores a CI connector that cannot build the repo', () => {
    // GitLab CI cannot build a GitHub repo.
    expect(choose({ connected: ['gitlab-ci'] }).ci).toBe('github-actions');
  });

  it('keeps the CI the repo already has, preferring one that is connected', () => {
    expect(choose({ existing: { ...NONE, jenkinsfile: true } }).ci).toBe('jenkins');
    expect(
      choose({
        existing: { ...NONE, githubCi: true, jenkinsfile: true },
        connected: ['jenkins'],
      }).reason,
    ).toBe('The repo already builds with Jenkins.');
  });

  it("prefers the host's CI when several are on, and says how to choose", () => {
    const c = choose({ connected: ['github-actions', 'jenkins'] });
    expect(c.ci).toBe('github-actions');
    expect(c.reason).toContain('Set spec.ship.ci to choose.');
    expect(choose({ provider: 'gitlab', connected: ['github-actions', 'jenkins'] }).ci).toBe(
      'jenkins',
    );
  });

  it('follows spec.ship.ci, unless that CI cannot build the repo', () => {
    expect(choose({ setting: 'jenkins', connected: ['github-actions'] }).ci).toBe('jenkins');
    const c = choose({ setting: 'gitlab-ci', connected: ['jenkins'] });
    expect(c.ci).toBe('jenkins');
    expect(c.reason).toMatch(/^spec\.ship\.ci is gitlab-ci, which cannot build a GitHub repo\./);
  });
});

describe('jenkinsfile', () => {
  const base = {
    image: 'registry.example.com/team/demo-app',
    chartDir: 'charts/demo-app',
    defaultBranch: 'main',
    test: { image: 'maven:3.9.16-eclipse-temurin-21', run: 'mvn -B test' },
  };

  it('tests, builds, lints the chart, and pushes, all in pinned images on Docker', () => {
    const f = jenkinsfile(base);
    expect(f.indexOf("stage('Test')")).toBeLessThan(f.indexOf("stage('Image')"));
    expect(f.indexOf("stage('Chart')")).toBeLessThan(f.indexOf("stage('Push')"));
    expect(f).toContain(
      'docker create -w /src --entrypoint sh maven:3.9.16-eclipse-temurin-21 -c "mvn -B test"',
    );
    expect(f).toContain('alpine/helm:4.3.0 -c "helm lint charts/demo-app');
    expect(f).toContain('docker cp ./. "$cid:/src"');
    expect(f).toContain("IMAGE = 'registry.example.com/team/demo-app'");
    // Shell variables are left to the shell: Groovy never interpolates a ''' string.
    expect(f).toContain('branch="${BRANCH_NAME:-${GIT_BRANCH#origin/}}"');
    expect(f).not.toMatch(/\bsh "/);
  });

  it('pushes pr-<sha> off the default branch, and <sha> and appVersion on it', () => {
    const f = jenkinsfile(base);
    expect(f).toContain('if [ "$branch" = "$DEFAULT_BRANCH" ] && [ -z "$CHANGE_ID" ]; then');
    expect(f).toContain('tags="pr-$sha"');
    expect(f).toContain('grep \'^appVersion:\' "$CHART_DIR/Chart.yaml"');
  });

  it('logs in only with the named credentials, never with a value in the file', () => {
    expect(jenkinsfile(base)).not.toContain('docker login');
    const f = jenkinsfile({ ...base, credentials: 'registry-push' });
    expect(f).toContain("usernamePassword(credentialsId: 'registry-push'");
    expect(f).toContain('echo "$REGISTRY_PASSWORD" | docker login "${IMAGE%%/*}"');
  });

  it('has no backslash Groovy would read as an escape', () => {
    expect(jenkinsfile(base)).not.toMatch(/\\/);
  });
});

describe('planShip with Jenkins', () => {
  const d = spring();
  const jenkins = {
    ci: 'jenkins' as const,
    reason: 'Jenkins is the CI connector that is turned on.',
  };

  it('writes a Jenkinsfile instead of GitHub Actions, pushing to the Jenkins registry', () => {
    const plan = planShip(d, {
      provider: 'github',
      repo: 'kodra-io/demo-app',
      defaultBranch: 'main',
      ci: jenkins,
      jenkins: { registry: 'Registry.example.com/team/', credentials: 'registry-push' },
    });
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain('Jenkinsfile');
    expect(paths.some((p) => p.includes('workflows'))).toBe(false);
    expect(plan.image).toBe('registry.example.com/team/demo-app');
    const values = plan.files.find((f) => f.path.endsWith('values.yaml'))?.content ?? '';
    expect(values).toContain('registry.example.com/team/demo-app');
    const body = shipPrBody({ detection: d, plan, verification: [], modelChanges: [] });
    expect(body).toContain('## CI\nJenkins. Jenkins is the CI connector that is turned on.');
    expect(body).toContain('The Jenkins credentials `registry-push`');
    expect(body).not.toMatch(/—/);
  });

  it("keeps the host's registry without one, and keeps an existing Jenkinsfile", () => {
    const plan = planShip(
      { ...d, existing: { ...d.existing, jenkinsfile: true } },
      { provider: 'github', repo: 'kodra-io/demo-app', defaultBranch: 'main', ci: jenkins },
    );
    expect(plan.image).toBe('ghcr.io/kodra-io/demo-app');
    expect(plan.files.some((f) => f.path === 'Jenkinsfile')).toBe(false);
    expect(plan.kept).toContain('CI: the Jenkinsfile exists, so it is left alone.');
  });

  it("does not look for B1's shared pipeline when Jenkins builds the repo", () => {
    const plan = planShip(d, {
      provider: 'github',
      repo: 'kodra-io/demo-app',
      defaultBranch: 'main',
      ci: jenkins,
      pipeline: { mode: 'auto', template: null, others: [], spec: null, secretPatterns: [] },
    });
    expect(plan.pipeline).toBeUndefined();
  });
});
