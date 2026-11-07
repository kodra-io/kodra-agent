import { describe, expect, it } from 'vitest';
import type { AgentDeps } from './agent.ts';
import { Redactor } from './redactor.ts';
import { workflowTools, type WorkflowJobView, type WorkflowRunner } from './workflow-tools.ts';

function runner(): WorkflowRunner & { started: unknown[] } {
  const jobs: WorkflowJobView[] = [];
  const started: unknown[] = [];
  return {
    started,
    repos: () => [{ provider: 'github', repo: 'acme/orders', canOpenPr: true }],
    list: () => jobs,
    get: (id) => jobs.find((j) => j.id === id) ?? null,
    start: (kind, repo, branch, by) => {
      if (repo !== 'acme/orders')
        return { status: 400, error: 'that is not one of the configured repos' };
      started.push({ kind, repo, branch, by });
      const job: WorkflowJobView = {
        id: `onb-${String(jobs.length + 1)}`,
        kind,
        repo,
        branch,
        state: 'done',
        startedAt: 't0',
        endedAt: 't1',
        prUrl: 'https://github.com/acme/orders/pull/1',
        summary: '*Onboarding acme/orders: ready to merge*',
        ok: true,
        log: ['Cloning acme/orders...', 'Jenkins passed'],
      };
      jobs.push(job);
      return { job: { id: job.id } };
    },
  };
}

function deps(over: Partial<AgentDeps>) {
  const audit: unknown[] = [];
  const d = {
    redactor: new Redactor(),
    audit: { append: (e: unknown) => Promise.resolve(void audit.push(e)) },
    actor: 'console:omar',
    ...over,
  } as unknown as AgentDeps;
  return { d, audit };
}

const run = async (tools: ReturnType<typeof workflowTools>, name: string, input: unknown) =>
  String(await tools[name]?.execute?.(input, { toolCallId: 'c1', messages: [] } as never));

describe('workflow tools (B6)', () => {
  it('are offered only with the running agent, and never in investigations', () => {
    expect(workflowTools(deps({}).d, 't')).toEqual({});
    expect(workflowTools(deps({ workflows: runner(), readOnly: true }).d, 't')).toEqual({});
    expect(Object.keys(workflowTools(deps({ workflows: runner() }).d, 't'))).toEqual([
      'kodra_repos',
      'kodra_onboard',
      'kodra_sandbox_test',
      'kodra_watch_release',
      'kodra_job',
    ]);
  });

  it('start the jobs as the user, audited, and read them back', async () => {
    const r = runner();
    const { d, audit } = deps({ workflows: r });
    const tools = workflowTools(d, 'task-1');
    const out = await run(tools, 'kodra_onboard', { repo: 'acme/orders' });
    expect(out).toContain('Started onboarding of acme/orders as job onb-1');
    expect(out).toContain('waits for an approver');
    expect(out).toContain('<tool_output');
    await run(tools, 'kodra_onboard', { repo: 'acme/orders', reportOnly: true, branch: 'dev' });
    await run(tools, 'kodra_sandbox_test', { repo: 'acme/orders' });
    await run(tools, 'kodra_watch_release', { repo: 'acme/orders' });
    expect(r.started).toEqual([
      { kind: 'pr', repo: 'acme/orders', branch: null, by: 'console:omar' },
      { kind: 'analyze', repo: 'acme/orders', branch: 'dev', by: 'console:omar' },
      { kind: 'sandbox', repo: 'acme/orders', branch: null, by: 'console:omar' },
      { kind: 'release', repo: 'acme/orders', branch: null, by: 'console:omar' },
    ]);
    const job = await run(tools, 'kodra_job', { id: 'onb-1' });
    expect(job).toContain('ready to merge');
    expect(job).toContain('Jenkins passed');
    expect(await run(tools, 'kodra_job', { id: 'nope' })).toContain('No job nope');
    expect(audit).toContainEqual(
      expect.objectContaining({ connector: 'kodra', tool: 'kodra_onboard', actor: 'console:omar' }),
    );
  });

  it('refuse a viewer, a missing repo, and a repo that is not configured', async () => {
    const r = runner();
    const viewer = workflowTools(deps({ workflows: r, workflowsAllowed: false }).d, 't');
    expect(await run(viewer, 'kodra_onboard', { repo: 'acme/orders' })).toContain(
      'only an approver',
    );
    const tools = workflowTools(deps({ workflows: r }).d, 't');
    expect(await run(tools, 'kodra_onboard', {})).toContain('name the repo');
    expect(await run(tools, 'kodra_onboard', { repo: 'other/x' })).toContain(
      'NOT STARTED: that is not one of the configured repos',
    );
    expect(r.started).toEqual([]);
    // Reading stays open to viewers.
    expect(await run(viewer, 'kodra_repos', {})).toContain('acme/orders');
  });
});
