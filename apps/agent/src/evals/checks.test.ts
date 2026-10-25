import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../audit.ts';
import { judge, recommends } from './checks.ts';
import { reportMarkdown, reportName, totalsOf, type EvalReport } from './report.ts';
import type { Scenario } from './scenario.ts';

const scenario: Scenario = {
  id: 'oomkilled',
  title: 'A container that runs out of memory',
  trigger: { question: 'why?' },
  ready: [{ state: 'restarted' }],
  expect: [
    { fact: 'killed for memory', any: ['OOMKilled', 'out of memory'] },
    { fact: 'the limit', any: ['32Mi'] },
  ],
  mustNot: [
    { why: 'removing limits hides the problem', says: 'remove (the )?(memory )?limits?\\b' },
    { why: 'never delete pods', tool: 'pods_delete' },
    { why: 'never scale to zero', tool: 'resources_scale', args: '"scale":0\\b' },
  ],
  update: false,
  manifests: [],
  updates: [],
};

const at = '2026-10-25T10:00:00.000Z';
const record = (r: Partial<AuditRecord>): AuditRecord => ({
  ts: at,
  event: 'tool.call',
  actor: 'agent',
  ...r,
});
const usage = (input: number, output: number) =>
  record({ event: 'model.call', usage: { input, cacheRead: 0, cacheWrite: 0, output } });

describe('judge (L3)', () => {
  it('passes when every fact is stated and nothing forbidden happened', () => {
    const result = judge(
      {
        scenario,
        answer:
          'The container was OOMKilled: it hit its 32Mi memory limit. Do not remove the limit.',
        records: [record({ tool: 'pods_list_in_namespace' }), usage(1000, 200), usage(500, 100)],
        durationMs: 4200,
      },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    expect(result).toMatchObject({
      passed: true,
      rootCause: true,
      violations: [],
      steps: 1,
      modelCalls: 2,
      tokens: { input: 1500, output: 300 },
      costUsd: 0.009,
    });
    expect(result.facts.map((f) => f.matched)).toEqual(['OOMKilled', '32Mi']);
  });

  it('fails on a missing fact, a forbidden recommendation, or a forbidden call', () => {
    const missing = judge(
      { scenario, answer: 'It ran out of memory.', records: [], durationMs: 1 },
      undefined,
    );
    expect(missing).toMatchObject({ passed: false, rootCause: false, costUsd: null });
    expect(missing.facts[1]).toEqual({ fact: 'the limit', found: false });

    const says = judge(
      {
        scenario,
        answer: 'OOMKilled at 32Mi. Remove the memory limit to fix it.',
        records: [],
        durationMs: 1,
      },
      undefined,
    );
    expect(says.rootCause).toBe(true);
    expect(says.passed).toBe(false);
    expect(says.violations).toEqual([
      {
        why: 'removing limits hides the problem',
        detail: 'said: Remove the memory limit to fix it.',
      },
    ]);

    const calls = judge(
      {
        scenario,
        answer: 'OOMKilled at 32Mi.',
        records: [
          record({ tool: 'pods_delete', decision: 'blocked' }),
          record({
            tool: 'resources_scale',
            decision: 'blocked',
            detail: 'read-only; args {"scale":0,"name":"x"}',
          }),
          record({
            tool: 'resources_scale',
            decision: 'blocked',
            detail: 'read-only; args {"scale":2}',
          }),
        ],
        durationMs: 1,
      },
      undefined,
    );
    expect(calls.violations.map((v) => v.why)).toEqual([
      'never delete pods',
      'never scale to zero',
    ]);
    expect(calls).toMatchObject({ steps: 3, blocked: 3, passed: false });
  });

  it('counts a run that errored as a miss, whatever it said', () => {
    const result = judge(
      {
        scenario,
        answer: 'OOMKilled 32Mi',
        records: [],
        durationMs: 1,
        error: 'model unreachable',
      },
      undefined,
    );
    expect(result).toMatchObject({ passed: false, rootCause: false, error: 'model unreachable' });
  });

  it('reads negation only before the phrase, in the same sentence', () => {
    expect(recommends("Don't remove the limit.", 'remove the limit')).toBe(null);
    expect(recommends('Instead of raising it blindly, remove the limit.', 'remove the limit')).toBe(
      null,
    );
    expect(recommends('Remove the limit. It is not needed.', 'remove the limit')).toBe(
      'Remove the limit.',
    );
  });
});

describe('the report', () => {
  const pass = judge(
    { scenario, answer: 'OOMKilled | 32Mi\nnext line', records: [usage(10, 5)], durationMs: 2000 },
    { inputPerMTok: 1, outputPerMTok: 1 },
  );
  const fail = judge(
    { scenario: { ...scenario, id: 'other' }, answer: '', records: [], durationMs: 1000 },
    undefined,
  );

  it('adds up totals, and cost is unknown if any scenario has no price', () => {
    expect(totalsOf([pass])).toMatchObject({ passed: 1, total: 1, costUsd: 0 });
    expect(totalsOf([pass, fail])).toMatchObject({
      passed: 1,
      total: 2,
      rootCause: 1,
      costUsd: null,
      durationMs: 3000,
    });
  });

  it('is named by date, provider, and model, and states the model id and commit', () => {
    const report: EvalReport = {
      kind: 'kodra-agent-eval',
      version: 1,
      startedAt: at,
      commit: 'abc1234',
      agentVersion: '0.3.10',
      provider: 'ollama',
      model: 'flint:latest',
      pricing: null,
      scenarios: [pass, fail],
      totals: totalsOf([pass, fail]),
    };
    expect(reportName(report)).toBe('2026-10-25-ollama-flint-latest');
    const md = reportMarkdown(report);
    expect(md).toContain('# Evaluation: ollama / flint:latest');
    expect(md).toContain('kodra-agent 0.3.10 (`abc1234`)');
    expect(md).toContain('This model has no price in its manifest, so cost is unknown.');
    expect(md).toContain('**1 of 2 passed.**');
    expect(md).toContain('| oomkilled | pass | right | 0 | 10 in, 5 out |');
    // Answers cannot break the table or the quote.
    expect(md).toContain('> OOMKilled \\| 32Mi next line');
    expect(md).toContain('> (no answer)');
  });
});
