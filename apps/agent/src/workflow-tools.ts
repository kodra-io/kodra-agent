import { dynamicTool, jsonSchema, type Tool } from 'ai';
import type { AgentDeps } from './agent.ts';
import { wrapUntrusted } from './agent.ts';

/**
 * The agent's own DevOps workflows as chat tools (B6): onboard a repo (report, pull request,
 * CI watched and fixed, sandbox test, report), test a branch in the sandbox, and watch a
 * release. Each one starts a background job in the running agent, the same job the console's
 * Repos page starts. Starting a job changes nothing by itself: every push, deploy, and build
 * start inside it asks the approvers first, like any other change, and is audited.
 */
export type WorkflowKind = 'analyze' | 'pr' | 'sandbox' | 'release';

export interface WorkflowJobView {
  id: string;
  kind: WorkflowKind;
  repo: string;
  branch: string | null;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  prUrl: string | null;
  summary?: string | undefined;
  ok?: boolean | undefined;
  log?: string[] | undefined;
  report?: string | null | undefined;
}

/** What the running agent offers: the console's onboarding jobs. */
export interface WorkflowRunner {
  repos(): { provider: 'github' | 'gitlab'; repo: string; canOpenPr: boolean }[];
  list(): Omit<WorkflowJobView, 'log' | 'report'>[];
  get(id: string): WorkflowJobView | null;
  start(
    kind: WorkflowKind,
    repo: string,
    branch: string | null,
    by: string,
  ): { job: { id: string } } | { error: string; status: number };
}

export const WORKFLOW_TOOLS = [
  'kodra_repos',
  'kodra_onboard',
  'kodra_sandbox_test',
  'kodra_watch_release',
  'kodra_job',
] as const;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const MAX_WAIT_S = 60;

/** The workflow tools, when the running agent has them (not in investigations). */
export function workflowTools(deps: AgentDeps, task: string): Record<string, Tool> {
  const runner = deps.workflows;
  if (!runner || deps.readOnly === true) return {};
  const actor = deps.actor ?? 'agent';
  const reply = (text: string) => wrapUntrusted('kodra', text, deps.redactor);
  const audit = (tool: string, detail: string) =>
    deps.audit.append({
      event: 'tool.call',
      actor,
      task,
      connector: 'kodra',
      tool,
      risk: 'read',
      decision: 'allowed',
      detail: deps.redactor.redact(detail),
    });

  const starter =
    (tool: string, kind: (input: Record<string, unknown>) => WorkflowKind, what: string) =>
    async (input: unknown) => {
      const raw = (input ?? {}) as Record<string, unknown>;
      if (deps.workflowsAllowed === false) {
        return reply(
          'NOT STARTED: only an approver can start onboarding, sandbox tests, and release checks. Ask an approver.',
        );
      }
      const repo = str(raw['repo']);
      if (!repo) return reply('NOT STARTED: name the repo, like owner/repo.');
      const branch = str(raw['branch']);
      const k = kind(raw);
      const started = runner.start(k, repo, branch, actor);
      if ('error' in started) {
        await audit(tool, `refused; ${repo}: ${started.error}`);
        return reply(`NOT STARTED: ${started.error}.`);
      }
      await audit(tool, `started ${started.job.id}; ${k} ${repo}${branch ? ` (${branch})` : ''}`);
      return reply(
        [
          `Started ${what} of ${repo} as job ${started.job.id}. It runs in the background and takes minutes.`,
          'Every change inside it (a push, a pull request, a build start, a sandbox deploy) waits for an approver in the console or Slack.',
          `Tell the user it started, then check it with kodra_job (id ${started.job.id}) when they ask, or wait on it once with waitSeconds. Do not start it again.`,
        ].join(' '),
      );
    };

  const repoArg = {
    repo: { type: 'string', description: 'owner/repo or group/project, from kodra_repos.' },
  } as const;
  return {
    kodra_repos: dynamicTool({
      description:
        '[kodra, read] The repos the agent can onboard, whether it may open pull requests there, and its recent onboarding, sandbox, and release jobs.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => {
        await audit('kodra_repos', 'listed');
        return reply(
          JSON.stringify({ repos: runner.repos(), jobs: runner.list().slice(0, 10) }, null, 2),
        );
      },
    }),
    kodra_onboard: dynamicTool({
      description:
        '[kodra, starts a job] Onboard a repo end to end, as a DevOps engineer: analyze it and report risks; add a Dockerfile, a pipeline with test, build, and deploy stages for the connected CI tool, and a Helm chart; open a pull request (after approval); watch its CI and fix the files it added when it fails; test the build in the sandbox; and report. With reportOnly, only the analysis.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          ...repoArg,
          branch: {
            type: 'string',
            description: 'The branch to start from; default: the default branch.',
          },
          reportOnly: { type: 'boolean', description: 'Only analyze and report; no pull request.' },
        },
        required: ['repo'],
      }),
      execute: starter(
        'kodra_onboard',
        (raw) => (raw['reportOnly'] === true ? 'analyze' : 'pr'),
        'onboarding',
      ),
    }),
    kodra_sandbox_test: dynamicTool({
      description:
        "[kodra, starts a job] Deploy a branch's image and chart to the sandbox namespace (after approval), smoke-test it, report, and destroy it.",
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          ...repoArg,
          branch: {
            type: 'string',
            description: 'The branch to test; default: the default branch.',
          },
        },
        required: ['repo'],
      }),
      execute: starter('kodra_sandbox_test', () => 'sandbox', 'a sandbox test'),
    }),
    kodra_watch_release: dynamicTool({
      description:
        "[kodra, starts a job] After a merge: watch the default branch's pipeline and its deploy stage, check that the deployment is healthy (image, ready replicas, or the VM's health endpoint), investigate with read-only tools if not, and report.",
      inputSchema: jsonSchema({ type: 'object', properties: repoArg, required: ['repo'] }),
      execute: starter('kodra_watch_release', () => 'release', 'a release check'),
    }),
    kodra_job: dynamicTool({
      description:
        '[kodra, read] The state of an onboarding, sandbox, or release job: running or finished, its report, the pull request, and the end of its log. waitSeconds (up to 60) waits for it to finish first.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The job id, like onb-1a2b3c4d.' },
          waitSeconds: { type: 'number', description: 'Wait up to this long for it to finish.' },
        },
        required: ['id'],
      }),
      execute: async (input) => {
        const raw = (input ?? {}) as Record<string, unknown>;
        const id = str(raw['id']) ?? '';
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(raw['waitSeconds']) || 0));
        let job = runner.get(id);
        for (
          const until = Date.now() + wait * 1000;
          job?.state === 'running' && Date.now() < until;
        ) {
          await new Promise((r) => setTimeout(r, 1000));
          job = runner.get(id);
        }
        await audit('kodra_job', `read ${id}`);
        if (!job) return reply(`No job ${id}. kodra_repos lists the recent ones.`);
        return reply(
          JSON.stringify(
            {
              id: job.id,
              kind: job.kind,
              repo: job.repo,
              state: job.state,
              startedAt: job.startedAt,
              endedAt: job.endedAt,
              prUrl: job.prUrl,
              ok: job.ok ?? null,
              summary: job.summary ?? null,
              logTail: (job.log ?? []).slice(-40),
            },
            null,
            2,
          ),
        );
      },
    }),
  };
}
