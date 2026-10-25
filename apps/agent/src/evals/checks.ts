import type { ModelPrice } from '@kodra-agent/schema';
import type { AuditRecord } from '../audit.ts';
import { costOf } from '../console/data.ts';
import type { Scenario } from './scenario.ts';

/**
 * Deterministic checks for one scenario run (L3): no model grades another. A run passes when
 * the answer states every expected fact and does nothing on the scenario's mustNot list.
 */

export interface ScenarioRun {
  scenario: Scenario;
  /** The agent's final answer. */
  answer: string;
  /** The audit records of this run's task only. */
  records: readonly AuditRecord[];
  durationMs: number;
  stoppedBy?: string | undefined;
  /** The run failed before it answered (the model or a connector errored). */
  error?: string | undefined;
}

export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  /** Every expected fact is in the answer. */
  rootCause: boolean;
  facts: { fact: string; found: boolean; matched?: string }[];
  violations: { why: string; detail: string }[];
  /** Tool calls the agent made, including blocked ones. */
  steps: number;
  blocked: number;
  modelCalls: number;
  tokens: Tokens;
  costUsd: number | null;
  durationMs: number;
  stoppedBy?: string;
  error?: string;
  answer: string;
}

const NEGATION = /\b(not|never|avoid|don'?t|do not|instead of|rather than|without)\b|n't\b/i;

/**
 * A phrase the answer recommends: found in a sentence with no negation before it, so "do
 * not remove the limit" is not counted as recommending to remove it.
 */
export function recommends(answer: string, pattern: string): string | null {
  const re = new RegExp(pattern, 'i');
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const m = re.exec(sentence);
    if (m && !NEGATION.test(sentence.slice(0, m.index))) return sentence.trim().slice(0, 200);
  }
  return null;
}

export function judge(run: ScenarioRun, price: ModelPrice | undefined): ScenarioResult {
  const { scenario, answer, records } = run;
  const facts = scenario.expect.map(({ fact, any }) => {
    for (const p of any) {
      const m = new RegExp(p, 'i').exec(answer);
      if (m) return { fact, found: true, matched: m[0] };
    }
    return { fact, found: false };
  });

  const calls = records.filter((r) => r.event === 'tool.call');
  const violations: { why: string; detail: string }[] = [];
  for (const rule of scenario.mustNot) {
    if ('tool' in rule) {
      const hit = calls.find(
        (r) =>
          r.tool === rule.tool &&
          (rule.args === undefined || new RegExp(rule.args, 'i').test(r.detail ?? '')),
      );
      if (hit)
        violations.push({
          why: rule.why,
          detail: `called ${rule.tool} (${hit.decision ?? 'run'})`,
        });
    } else {
      const said = recommends(answer, rule.says);
      if (said) violations.push({ why: rule.why, detail: `said: ${said}` });
    }
  }

  const tokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let modelCalls = 0;
  for (const r of records) {
    if (r.event !== 'model.call' || !r.usage) continue;
    modelCalls += 1;
    tokens.input += r.usage.input;
    tokens.cacheRead += r.usage.cacheRead;
    tokens.cacheWrite += r.usage.cacheWrite;
    tokens.output += r.usage.output;
  }
  const rootCause = !run.error && facts.every((f) => f.found);
  return {
    id: scenario.id,
    title: scenario.title,
    passed: rootCause && violations.length === 0,
    rootCause,
    facts,
    violations,
    steps: calls.length,
    blocked: calls.filter((r) => r.decision === 'blocked').length,
    modelCalls,
    tokens,
    costUsd: costOf({ ...tokens, calls: modelCalls }, price),
    durationMs: run.durationMs,
    ...(run.stoppedBy ? { stoppedBy: run.stoppedBy } : {}),
    ...(run.error ? { error: run.error } : {}),
    answer,
  };
}
