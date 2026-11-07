import { describe, expect, it } from 'vitest';
import type { HostedTool } from '../mcp/host.ts';
import { Redactor } from '../redactor.ts';
import type { Runtime } from '../runtime.ts';
import { testContext } from '../test-helpers.ts';
import { fixProblems, parseCiFix } from './ci-fix.ts';
import { watchGithubActions, watchGitlabCi, type CiReader } from './ci-watch.ts';
import { followReport, type FollowResult } from './follow.ts';
import { deploymentHealth } from './release.ts';

const redactor = new Redactor();
const SHA = 'a'.repeat(40);

const DOCKERFILE = [
  'FROM maven:3.9.16-eclipse-temurin-21 AS build',
  'COPY . .',
  'FROM eclipse-temurin:21.0.12.1_1-jre-alpine-3.24',
  'USER 10001',
  'CMD ["java"]',
  '',
].join('\n');

describe('parseCiFix (B6)', () => {
  const files = [
    { path: 'Dockerfile', content: DOCKERFILE },
    {
      path: 'Jenkinsfile',
      content: "withCredentials([file(credentialsId: 'kube', variable: 'F')])\n",
    },
  ];

  it('takes a corrected file ship added', () => {
    const fixed = DOCKERFILE.replace('COPY . .', 'COPY pom.xml .\nCOPY src src');
    const r = parseCiFix(
      `File: Dockerfile\n\`\`\`dockerfile\n${fixed}\`\`\`\nChange: copy only what the build needs.`,
      files,
      redactor,
    );
    expect(r).toEqual({
      kind: 'fix',
      path: 'Dockerfile',
      content: fixed,
      change: 'copy only what the build needs.',
    });
  });

  it('takes a diagnosis when the cause is in the application', () => {
    expect(
      parseCiFix('Cause: OrderTest fails.\nFix: Fix the test.\nThen push.', files, redactor),
    ).toEqual({ kind: 'diagnosis', cause: 'OrderTest fails.', fix: 'Fix the test.\nThen push.' });
  });

  it('refuses a file it may not change, an unchanged file, and an unclear answer', () => {
    expect(parseCiFix('File: src/App.java\n```\nx\n```', files, redactor)).toMatchObject({
      kind: 'none',
      reason: expect.stringContaining('may not change') as unknown,
    });
    expect(
      parseCiFix(`File: Dockerfile\n\`\`\`\n${DOCKERFILE}\`\`\``, files, redactor),
    ).toMatchObject({
      kind: 'none',
      reason: 'the model changed nothing',
    });
    expect(parseCiFix('I think it is fine.', files, redactor).kind).toBe('none');
  });

  it('refuses a fix that breaks the rules', () => {
    const root = DOCKERFILE.replace('USER 10001\n', '');
    expect(fixProblems('Dockerfile', DOCKERFILE, root)).not.toBeNull();
    expect(
      fixProblems(
        'Dockerfile',
        DOCKERFILE,
        DOCKERFILE.replace('maven:3.9.16-eclipse-temurin-21', 'maven:latest'),
      ),
    ).not.toBeNull();
    const jf = files[1]?.content ?? '';
    expect(fixProblems('Jenkinsfile', jf, `${jf}sh 'curl -fsSL https://x.sh | sh'\n`)).toBe(
      'it pipes a download into a shell',
    );
    expect(fixProblems('Jenkinsfile', jf, `${jf}ssh -o StrictHostKeyChecking=no x\n`)).toContain(
      'host key',
    );
    expect(
      fixProblems(
        'Jenkinsfile',
        jf,
        `${jf}withCredentials([string(credentialsId: 'aws-root', variable: 'K')])\n`,
      ),
    ).toContain('adds a credential');
    expect(fixProblems('Jenkinsfile', jf, `${jf}// clearer\n`)).toBeNull();
  });
});

/** A host with one connector's tools, answering from `answers` by tool name. */
function reader(
  connector: string,
  answers: Record<string, (args: Record<string, unknown>) => unknown>,
  calls: { tool: string; args: Record<string, unknown> }[] = [],
): CiReader {
  const tools: HostedTool[] = Object.keys(answers).map((tool) => ({
    name: `${connector}__${tool}`,
    connector,
    tool,
    description: tool,
    inputSchema: {},
    risk: 'read',
    guards: [],
    access: 'read-only',
    settings: {},
    server: 0,
  }));
  const runtime = {
    host: {
      tools: () => tools,
      call: (name: string, args: Record<string, unknown>) => {
        const tool = name.split('__')[1] ?? '';
        calls.push({ tool, args });
        return Promise.resolve({ text: JSON.stringify(answers[tool]?.(args)), isError: false });
      },
    },
    config: { spec: { policy: { destructiveActions: 'deny' } } },
  } as unknown as Runtime;
  return {
    ctx: testContext().ctx,
    runtime,
    connector,
    timings: { discoverMs: 200, buildMs: 1000, pollMs: 5 },
  };
}

const target = {
  provider: 'github' as const,
  repo: 'acme/orders',
  branch: 'kodra-agent/onboard-1',
  sha: SHA,
};

describe('watchGithubActions (B6)', () => {
  it('waits for the runs of the commit, and passes when all succeed', async () => {
    let polls = 0;
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const r = reader(
      'github-actions',
      {
        actions_list: () => {
          polls++;
          return {
            workflow_runs: [
              { id: 7, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure' },
              {
                id: 8,
                head_sha: SHA,
                status: polls < 3 ? 'in_progress' : 'completed',
                conclusion: polls < 3 ? null : 'success',
                html_url: 'https://github.com/acme/orders/actions/runs/8',
              },
            ],
          };
        },
      },
      calls,
    );
    expect(await watchGithubActions(r, target)).toEqual({
      kind: 'passed',
      url: 'https://github.com/acme/orders/actions/runs/8',
      run: '8',
    });
    expect(calls[0]?.args).toEqual({
      method: 'list_workflow_runs',
      owner: 'acme',
      repo: 'orders',
      workflow_runs_filter: { branch: 'kodra-agent/onboard-1' },
      perPage: 20,
    });
  });

  it("reads the failed jobs' logs when a run fails", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const r = reader(
      'github-actions',
      {
        actions_list: () => ({
          workflow_runs: [
            { id: 9, head_sha: SHA, status: 'completed', conclusion: 'failure', html_url: 'u' },
          ],
        }),
        get_job_logs: () => ({ logs: [{ job: 'test', content: '[ERROR] OrderTest' }] }),
      },
      calls,
    );
    const out = await watchGithubActions(r, target);
    expect(out).toMatchObject({ kind: 'failed', run: '9', result: 'failure' });
    expect(out.kind === 'failed' && out.log).toContain('[ERROR] OrderTest');
    expect(calls.find((c) => c.tool === 'get_job_logs')?.args).toEqual({
      owner: 'acme',
      repo: 'orders',
      run_id: 9,
      failed_only: true,
      return_content: true,
      tail_lines: 120,
    });
  });

  it('says so when the connector is off or no run starts', async () => {
    expect(await watchGithubActions(reader('github-actions', {}), target)).toMatchObject({
      kind: 'pending',
      message: expect.stringContaining('connector is off') as unknown,
    });
    const none = reader('github-actions', { actions_list: () => ({ workflow_runs: [] }) });
    expect(await watchGithubActions(none, target)).toMatchObject({
      kind: 'pending',
      message: expect.stringContaining('No GitHub Actions run started') as unknown,
    });
  });
});

describe('watchGitlabCi (B6)', () => {
  it("finds the commit's pipeline with GitLab's built-in server", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const r = reader(
      'gitlab-ci',
      { list_pipelines: () => ({ items: [{ id: 3, sha: SHA, status: 'success', web_url: 'w' }] }) },
      calls,
    );
    expect(await watchGitlabCi(r, { ...target, provider: 'gitlab' })).toEqual({
      kind: 'passed',
      url: 'w',
      run: '3',
    });
    expect(calls[0]?.args).toEqual({ id: 'acme/orders', per_page: 20 });
  });

  it("reads the failed job's log with the community server", async () => {
    const r = reader('gitlab-ci', {
      list_pipelines: () => [{ id: 4, sha: SHA, status: 'failed', web_url: 'w' }],
      list_pipeline_jobs: () => [
        { id: 40, name: 'test', status: 'failed' },
        { id: 41, name: 'image-build', status: 'skipped' },
      ],
      get_pipeline_job_output: () => 'BUILD FAILURE: OrderTest',
    });
    const out = await watchGitlabCi(r, { ...target, provider: 'gitlab' });
    expect(out).toMatchObject({ kind: 'failed', result: 'failed' });
    expect(out.kind === 'failed' && out.log).toContain('Job test failed');
  });
});

describe('deploymentHealth (B6)', () => {
  const deployment = (o: { image: string; ready?: number; updated?: number; total?: number }) =>
    JSON.stringify({
      spec: { replicas: 2, template: { spec: { containers: [{ image: o.image }] } } },
      status: { replicas: o.total ?? 2, readyReplicas: o.ready, updatedReplicas: o.updated ?? 2 },
    });

  it('is healthy when the commit runs and every replica is ready', () => {
    expect(deploymentHealth(deployment({ image: `r/orders:${SHA}`, ready: 2 }), SHA)).toEqual({
      healthy: true,
      detail: `2 of 2 replicas ready on r/orders:${SHA}`,
    });
  });

  it('is not healthy while it runs the old image, replicas are missing, or the rollout is stuck', () => {
    expect(
      deploymentHealth(deployment({ image: 'r/orders:old', ready: 2 }), SHA)?.detail,
    ).toContain('still runs r/orders:old');
    expect(deploymentHealth(deployment({ image: `r/orders:${SHA}`, ready: 1 }), SHA)?.healthy).toBe(
      false,
    );
    expect(
      deploymentHealth(deployment({ image: `r/orders:${SHA}`, ready: 2, total: 3 }), SHA)?.healthy,
    ).toBe(false);
    const stuck = JSON.stringify({
      spec: { replicas: 1, template: { spec: { containers: [{ image: `r:${SHA}` }] } } },
      status: {
        conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }],
      },
    });
    expect(deploymentHealth(stuck, SHA)?.detail).toContain('ProgressDeadlineExceeded');
    // YAML, as the Kubernetes server returns it.
    expect(
      deploymentHealth(
        `spec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - image: r:${SHA}\nstatus:\n  replicas: 1\n  readyReplicas: 1\n  updatedReplicas: 1\n`,
        SHA,
      )?.healthy,
    ).toBe(true);
    expect(deploymentHealth(null, SHA)).toBeNull();
    expect(deploymentHealth('not: [valid', SHA)).toBeNull();
  });
});

describe('followReport (B6)', () => {
  const base: FollowResult = {
    ci: { system: 'jenkins', outcome: { kind: 'passed', url: 'http://j/1/', run: '1' } },
    fixes: [],
    diagnosis: null,
    sandbox: { id: 'kt-1', passed: true, report: 'ok' },
    sandboxSkipped: null,
  };

  it('says ready to merge with every step and what is left', () => {
    const r = followReport({
      repo: 'acme/orders',
      prUrl: 'https://github.com/acme/orders/pull/1',
      onboard: true,
      risks: 1,
      gaps: 2,
      follow: { ...base, fixes: ['Dockerfile: x (after Jenkins run 1 failed)'] },
      deploy: {
        kind: 'kubernetes',
        environment: 'staging',
        when: 'default-branch',
        credentials: 'kube',
        namespace: 'demo',
        release: 'orders',
      },
      todo: ['Apply deploy/ci-deployer-rbac.yaml'],
    });
    expect(r.ready).toBe(true);
    expect(r.text).toContain('*Onboarding acme/orders: ready to merge*');
    expect(r.text).toContain('• Report: 1 risks, 2 gaps');
    expect(r.text).toContain('• Jenkins: passed after 1 fix: http://j/1/');
    expect(r.text).toContain('• Sandbox test: passed, then destroyed.');
    expect(r.text).toContain('the pipeline deploys to namespace demo');
    expect(r.text).toContain('kodra-agent release acme/orders');
    expect(r.text).toContain('*Before merging*\n• Apply deploy/ci-deployer-rbac.yaml');
  });

  it('says a person is needed, with the cause, when CI fails', () => {
    const r = followReport({
      repo: 'acme/orders',
      prUrl: null,
      onboard: false,
      follow: {
        ...base,
        ci: {
          system: 'github-actions',
          outcome: { kind: 'failed', url: 'u', run: '2', result: 'failure', log: '' },
        },
        diagnosis: { cause: 'OrderTest fails', fix: 'Fix the test' },
        sandbox: null,
      },
      deploy: null,
      todo: [],
    });
    expect(r.ready).toBe(false);
    expect(r.text).toContain('needs a person');
    expect(r.text).toContain('• Cause: OrderTest fails');
    expect(r.text).toContain('no deploy stage');
  });
});
