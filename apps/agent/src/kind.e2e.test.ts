import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import {
  configYaml,
  posixPath,
  scriptedPrompter,
  tempDir,
  testContext,
  writeConfig,
} from './test-helpers.ts';

/**
 * M4 done criteria against a real kind cluster and the real Kubernetes MCP server:
 * chat explains a crashlooping pod with read-only tools, a write asks for approval in the
 * CLI, and a blocked action lands in the audit log. Run with `pnpm test:kind`, which
 * creates the cluster and sets KODRA_KIND_KUBECONFIG. The model is scripted, so no API key
 * is needed; scripts/demo-crashloop.ts runs the same scenario with a real model.
 */
const kubeconfig = process.env['KODRA_KIND_KUBECONFIG'];
const NS = 'payments';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const toolCall = (toolName: string, input: Record<string, unknown>) => ({
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: `c-${String(Date.now())}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'end_turn' },
  usage,
  warnings: [],
});

/** The text of the latest tool result in a prompt. */
interface CallOptions {
  prompt: { role: string; content: unknown }[];
}

function lastToolOutput(options: CallOptions): string {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== 'tool') continue;
    return JSON.stringify(message.content);
  }
  return '';
}

/** A model that investigates like a careful engineer would, step by step. */
function scriptedModel() {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const lastUser = [...options.prompt].reverse().find((m) => m.role === 'user');
      const ask = JSON.stringify(lastUser?.content ?? '');
      const toolTurns = options.prompt.filter((m) => m.role === 'tool').length;
      const sinceUser = options.prompt.length - 1 - options.prompt.lastIndexOf(lastUser as never);

      if (ask.includes('why')) {
        if (sinceUser === 0)
          return Promise.resolve(toolCall('kubernetes__pods_list_in_namespace', { namespace: NS }));
        if (sinceUser === 2) {
          const pod = /crashloop-[a-z0-9]+-[a-z0-9]+/.exec(lastToolOutput(options))?.[0];
          return Promise.resolve(
            pod
              ? toolCall('kubernetes__pods_log', { namespace: NS, name: pod, previous: true })
              : say('I could not find the crashlooping pod.'),
          );
        }
        const logs = lastToolOutput(options);
        const line = /Error: [^"\\]+/.exec(logs)?.[0] ?? 'no error line found';
        return Promise.resolve(say(`The pod keeps crashing. Its last log line: ${line}`));
      }
      if (ask.includes('scale')) {
        if (sinceUser === 0) {
          return Promise.resolve(
            toolCall('kubernetes__resources_scale', {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              namespace: NS,
              name: 'crashloop',
              scale: 2,
              kodra_reason: 'test: scale to two replicas',
            }),
          );
        }
        return Promise.resolve(say('Done.'));
      }
      if (ask.includes('system')) {
        if (sinceUser === 0)
          return Promise.resolve(
            toolCall('kubernetes__pods_list_in_namespace', { namespace: 'kube-system' }),
          );
        return Promise.resolve(say('That namespace is off limits.'));
      }
      return Promise.resolve(say(`unexpected (${String(toolTurns)})`));
    },
  });
}

describe.skipIf(!kubeconfig)('kind: crashlooping pod', () => {
  it(
    'explains the crash, asks before scaling, and audits a blocked read',
    { timeout: 180_000 },
    async () => {
      const dir = await tempDir();
      const auditPath = join(dir, 'audit', 'audit.jsonl');
      const path = await writeConfig(
        configYaml({
          auditPath: posixPath(auditPath),
          model:
            '    provider: anthropic\n    name: scripted\n    apiKey: ${env:ANTHROPIC_API_KEY}',
          connectors: [
            '    kubernetes:',
            '      enabled: true',
            '      access: read-write-approved',
            `      config: {namespaces: [${NS}]}`,
            `      secrets: {kubeconfig: '\${file:${posixPath(kubeconfig ?? '')}}'}`,
          ].join('\n'),
        }),
        dir,
      );
      const model = scriptedModel();
      const run = async (message: string, prompter = scriptedPrompter([])) => {
        const t = testContext({
          env: { ANTHROPIC_API_KEY: 'not-used-by-the-scripted-model' },
          modelFactory: () => model,
          prompter,
        });
        const code = await main(['chat', '--config', path, '--message', message], t.ctx);
        return { code, out: t.output() };
      };

      // 1. Read-only investigation against the real cluster.
      const why = await run('why is the crashloop deployment failing?');
      expect(why.code).toBe(0);
      expect(why.out).toContain('[read] kubernetes/pods_list_in_namespace');
      expect(why.out).toContain('[read] kubernetes/pods_log');
      expect(why.out).toContain('Its last log line: Error: cannot connect to database at db:5432');

      // 2. A write asks for approval at the terminal, then runs.
      const approver = scriptedPrompter([true]);
      const scale = await run('scale the crashloop deployment to 2', approver);
      expect(approver.asked).toEqual(['Approve this action?']);
      expect(scale.out).toContain('Approval needed (write): kubernetes / resources_scale');
      expect(scale.out).toContain('Why:       test: scale to two replicas');
      const replicas = execFileSync(
        'kubectl',
        [
          '--kubeconfig',
          kubeconfig ?? '',
          '-n',
          NS,
          'get',
          'deployment',
          'crashloop',
          '-o',
          'jsonpath={.spec.replicas}',
        ],
        {
          encoding: 'utf8',
        },
      );
      expect(replicas).toBe('2');

      // 3. A read outside the configured namespaces is blocked and audited.
      const blocked = await run('what runs in kube-system?');
      expect(blocked.out).toContain('[blocked] kubernetes/pods_list_in_namespace');

      const audit = (await readFile(auditPath, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, string>);
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'approval.decision',
          decision: 'approved',
          tool: 'resources_scale',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          decision: 'approved',
          tool: 'resources_scale',
        }),
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          event: 'tool.call',
          decision: 'blocked',
          tool: 'pods_list_in_namespace',
        }),
      );
    },
  );
});
