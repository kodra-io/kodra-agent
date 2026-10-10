import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn, type AgentDeps } from './agent.ts';
import type { ApprovalOutcome, ApprovalRequest } from './approvals.ts';
import { AuditLog } from './audit.ts';
import { MAX_PREVIEW_CHARS, PROPOSE_CHANGE } from './changes.ts';
import type { FileReader } from './forge-files.ts';
import { jsonLogger, memoryTerminal } from './io.ts';
import { ConnectorHost } from './mcp/host.ts';
import { Redactor } from './redactor.ts';
import { fakeGitComponent, fakeLauncher } from './test-fixtures/fake-connector.ts';
import { tempDir } from './test-helpers.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const SECRET = 'sk-change-preview-secret-71c4'; // gitleaks:allow

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const propose = (input: Record<string, unknown>): GenerateResult => ({
  content: [
    {
      type: 'tool-call',
      toolCallId: 'c-change',
      toolName: PROPOSE_CHANGE,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage,
  warnings: [],
});
const answer = (text: string): GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage,
  warnings: [],
});

const repo = { owner: 'acme', repo: 'api' };
const branchStep = { tool: 'fakegit__create_branch', args: { ...repo, branch: 'fix/replicas' } };
const fileStep = (content: string, path = 'deploy/values.yaml', branch = 'fix/replicas') => ({
  tool: 'fakegit__create_or_update_file',
  args: { ...repo, path, content, message: 'Raise replicas', branch },
});
const prStep = {
  tool: 'fakegit__create_pull_request',
  args: { ...repo, title: 'Raise replicas to 3', head: 'fix/replicas', base: 'main' },
};
const change = (steps: unknown[]) => ({
  title: 'Raise web replicas to 3',
  reason: 'Traffic is up',
  steps,
});

let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function setup(opts: {
  responses: GenerateResult[];
  decide?: (req: ApprovalRequest) => ApprovalOutcome | Promise<ApprovalOutcome>;
  readOnly?: boolean;
}) {
  const dir = await tempDir();
  const recordPath = join(dir, 'calls.jsonl');
  const auditPath = join(dir, 'audit.jsonl');
  const files = new Map<string, string>([
    ['acme/api#main#deploy/values.yaml', 'replicas: 2\nimage: web:1\n'],
  ]);
  const reads: string[] = [];
  const readFile_: FileReader = (r, path, ref) => {
    reads.push(`${r}#${ref}#${path}`);
    return Promise.resolve(files.get(`${r}#${ref}#${path}`) ?? null);
  };
  const redactor = new Redactor();
  redactor.add(SECRET);
  host = await ConnectorHost.start(
    [
      {
        component: fakeGitComponent(),
        access: 'read-write-approved',
        secrets: {},
        defaultBranches: new Map([['acme/api', 'main']]),
        readFile: readFile_,
      },
    ],
    {
      redactor,
      log: jsonLogger(() => undefined, redactor),
      launcher: fakeLauncher({ record: recordPath }),
      env: {},
    },
  );
  const requests: ApprovalRequest[] = [];
  const model = new MockLanguageModelV4({ doGenerate: opts.responses });
  const deps: AgentDeps = {
    model,
    modelLabel: 'mock/model',
    host,
    approvals: {
      request: async (req) => {
        requests.push(req);
        return opts.decide ? opts.decide(req) : { decision: 'approved', by: 'console:omar' };
      },
    },
    audit: new AuditLog(auditPath, redactor),
    redactor,
    term: memoryTerminal(redactor),
    policy: { destructiveActions: 'deny', expiresAfterMinutes: 15 },
    ...(opts.readOnly ? { readOnly: true } : {}),
  };
  const recorded = async () =>
    (await readFile(recordPath, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { tool: string }).tool);
  const audit = async () =>
    (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
  const toolResult = () => JSON.stringify(model.doGenerateCalls[1]?.prompt);
  return { deps, model, requests, recorded, audit, files, reads, toolResult };
}

describe('propose_change', () => {
  it('previews a branch, a diff, and a pull request, asks once, then runs every step in order', async () => {
    const t = await setup({
      responses: [
        propose(change([branchStep, fileStep('replicas: 3\nimage: web:1\n'), prStep])),
        answer('Opened the pull request.'),
      ],
    });
    await runTurn(t.deps, [], 'raise replicas', 'ch1');

    expect(t.requests).toHaveLength(1);
    const req = t.requests[0];
    expect(req).toMatchObject({
      tool: PROPOSE_CHANGE,
      title: 'Raise web replicas to 3',
      risk: 'write',
    });
    expect(req?.preview).toContain('create branch fix/replicas in acme/api, from main');
    // The file is read where the new branch starts (the default branch): once for the
    // preview, and once more right before the write, to check it did not change.
    expect(t.reads).toEqual([
      'acme/api#main#deploy/values.yaml',
      'acme/api#main#deploy/values.yaml',
    ]);
    expect(req?.preview).toContain('--- a/deploy/values.yaml (main)');
    expect(req?.preview).toContain('-replicas: 2\n+replicas: 3\n image: web:1');
    expect(req?.preview).toContain('open a pull request in acme/api, fix/replicas into main');

    expect(await t.recorded()).toEqual([
      'create_branch',
      'create_or_update_file',
      'create_pull_request',
    ]);
    expect(t.toolResult()).toContain('ran, all 3 steps');
    const records = await t.audit();
    expect(records.filter((r) => r['event'] === 'approval.request').map((r) => r['tool'])).toEqual([
      PROPOSE_CHANGE,
    ]);
    expect(
      records.filter((r) => r['event'] === 'tool.call').map((r) => `${r['tool']}:${r['decision']}`),
    ).toEqual([
      'create_branch:approved',
      'create_or_update_file:approved',
      'create_pull_request:approved',
    ]);
    expect(records.find((r) => r['event'] === 'approval.decision')).toMatchObject({
      actor: 'console:omar',
      decision: 'approved',
    });
  });

  it('proposes nothing when a step is blocked, and asks nobody', async () => {
    const t = await setup({
      responses: [
        propose(change([fileStep('replicas: 3\n', 'deploy/values.yaml', 'main')])),
        answer('Blocked.'),
      ],
    });
    await runTurn(t.deps, [], 'edit main', 'ch2');
    expect(t.requests).toEqual([]);
    expect(await t.recorded()).toEqual([]);
    expect(t.toolResult()).toContain(
      'NOT PROPOSED: step 1 (fakegit/create_or_update_file) is blocked by policy',
    );
    expect((await t.audit()).find((r) => r['event'] === 'tool.call')).toMatchObject({
      decision: 'blocked',
    });
  });

  it('stops before a write when the file changed after the preview', async () => {
    const t = await setup({
      responses: [
        propose(change([branchStep, fileStep('replicas: 3\nimage: web:1\n'), prStep])),
        answer('Stopped.'),
      ],
      decide: () => {
        t.files.set('acme/api#main#deploy/values.yaml', 'replicas: 5\nimage: web:2\n');
        return { decision: 'approved', by: 'console:omar' };
      },
    });
    await runTurn(t.deps, [], 'raise replicas', 'ch3');
    // The branch was created; the file was not written and no pull request was opened.
    expect(await t.recorded()).toEqual(['create_branch']);
    expect(t.toolResult()).toContain('stopped at step 2/3');
    expect(t.toolResult()).toContain('deploy/values.yaml changed on main after the preview');
    expect((await t.audit()).some((r) => r['event'] === 'error')).toBe(true);
  });

  it('runs nothing when denied, and passes the reason on', async () => {
    const t = await setup({
      responses: [propose(change([branchStep, fileStep('replicas: 3\n'), prStep])), answer('OK.')],
      decide: () => ({ decision: 'denied', by: 'console:omar', note: 'wait for the release' }),
    });
    await runTurn(t.deps, [], 'raise replicas', 'ch4');
    expect(await t.recorded()).toEqual([]);
    expect(t.toolResult()).toContain('denied this change, saying: wait for the release');
  });

  it('shows a new file as added, and redacts secrets in the preview', async () => {
    const t = await setup({
      responses: [
        propose(change([branchStep, fileStep(`token: ${SECRET}\n`, 'config/new.yaml')])),
        answer('Done.'),
      ],
    });
    await runTurn(t.deps, [], 'add config', 'ch5');
    const preview = t.requests[0]?.preview ?? '';
    expect(preview).toContain('add config/new.yaml in acme/api on fix/replicas');
    expect(preview).toContain('--- /dev/null');
    expect(preview).not.toContain(SECRET);
  });

  it('refuses unknown tools and changes too large to review', async () => {
    const t = await setup({
      responses: [
        propose(change([{ tool: 'fakegit__delete_everything', args: {} }])),
        propose(change([branchStep, fileStep('x\n'.repeat(MAX_PREVIEW_CHARS))])),
        answer('Done.'),
      ],
    });
    await runTurn(t.deps, [], 'try', 'ch6');
    const prompts = JSON.stringify(t.model.doGenerateCalls.map((c) => c.prompt));
    expect(prompts).toContain('step 1 names a tool you were not given');
    expect(prompts).toContain('too large to review in one approval');
    expect(t.requests).toEqual([]);
    expect(await t.recorded()).toEqual([]);
  });

  it('is not offered in read-only investigations', async () => {
    const t = await setup({ responses: [answer('Nothing to do.')], readOnly: true });
    await runTurn(t.deps, [], 'look', 'ch7');
    const names = (t.model.doGenerateCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).not.toContain(PROPOSE_CHANGE);
  });
});
