import type { ScenarioResult, Tokens } from './checks.ts';

/** One evaluation run (L3): what was run, against which model, and each scenario's result. */
export interface EvalReport {
  kind: 'kodra-agent-eval';
  version: 1;
  /** ISO time the run started. */
  startedAt: string;
  commit: string;
  agentVersion: string;
  provider: string;
  model: string;
  /** Where the price came from, or null when the model has none (cost is then unknown). */
  pricing: string | null;
  scenarios: ScenarioResult[];
  totals: {
    passed: number;
    total: number;
    rootCause: number;
    steps: number;
    tokens: Tokens;
    costUsd: number | null;
    durationMs: number;
  };
}

export function totalsOf(results: readonly ScenarioResult[]): EvalReport['totals'] {
  const tokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let cost: number | null = 0;
  for (const r of results) {
    tokens.input += r.tokens.input;
    tokens.cacheRead += r.tokens.cacheRead;
    tokens.cacheWrite += r.tokens.cacheWrite;
    tokens.output += r.tokens.output;
    cost = cost === null || r.costUsd === null ? null : cost + r.costUsd;
  }
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    rootCause: results.filter((r) => r.rootCause).length,
    steps: results.reduce((n, r) => n + r.steps, 0),
    tokens,
    costUsd: cost === null ? null : Math.round(cost * 10_000) / 10_000,
    durationMs: results.reduce((n, r) => n + r.durationMs, 0),
  };
}

/** The file name a report is saved under, like 2026-10-25-ollama-flint-latest. */
export function reportName(report: Pick<EvalReport, 'startedAt' | 'provider' | 'model'>): string {
  const slug = `${report.provider}-${report.model}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  return `${report.startedAt.slice(0, 10)}-${slug.replace(/^-+|-+$/g, '')}`;
}

const dollars = (n: number | null) => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
const tokenCount = (t: Tokens) => `${String(t.input)} in, ${String(t.output)} out`;
// Answers go into Markdown table cells and blockquotes: keep them on one line, no pipes.
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function reportMarkdown(r: EvalReport): string {
  const t = r.totals;
  const lines = [
    `# Evaluation: ${r.provider} / ${r.model}`,
    '',
    `Run on ${r.startedAt.slice(0, 10)} at ${r.startedAt.slice(11, 16)} UTC, kodra-agent ${r.agentVersion} (\`${r.commit}\`).`,
    `Model id: \`${r.model}\` through \`${r.provider}\`. Investigations are read-only. Checks are deterministic: no model grades the answers.`,
    r.pricing
      ? `Cost uses ${r.pricing}.`
      : 'This model has no price in its manifest, so cost is unknown.',
    '',
    `**${String(t.passed)} of ${String(t.total)} passed.** Right root cause in ${String(t.rootCause)} of ${String(t.total)}; ${String(t.steps)} tool calls; ${tokenCount(t.tokens)} tokens; cost ${dollars(t.costUsd)}; ${seconds(t.durationMs)}.`,
    '',
    '| Scenario | Result | Root cause | Steps | Tokens | Cost | Time |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.scenarios.map(
      (s) =>
        `| ${s.id} | ${s.passed ? 'pass' : 'fail'} | ${s.rootCause ? 'right' : 'missed'} | ${String(s.steps)} | ${tokenCount(s.tokens)} | ${dollars(s.costUsd)} | ${seconds(s.durationMs)} |`,
    ),
    '',
    '## Details',
  ];
  for (const s of r.scenarios) {
    lines.push('', `### ${s.id}: ${s.title}`, '');
    for (const f of s.facts) {
      lines.push(
        `- ${f.found ? 'Found' : 'Missing'}: ${f.fact}${f.matched ? ` ("${cell(f.matched)}")` : ''}`,
      );
    }
    for (const v of s.violations) lines.push(`- Must not: ${v.why}. ${cell(v.detail)}`);
    if (s.blocked > 0) lines.push(`- ${String(s.blocked)} tool call(s) blocked by policy.`);
    if (s.stoppedBy) lines.push(`- Stopped by: ${s.stoppedBy}.`);
    if (s.error) lines.push(`- Error: ${cell(s.error)}`);
    lines.push('', `> ${cell(s.answer).slice(0, 1200) || '(no answer)'}`);
  }
  return `${lines.join('\n')}\n`;
}
