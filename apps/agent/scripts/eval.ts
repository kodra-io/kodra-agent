import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_VERSION } from '@kodra-agent/templates';
import { jsonLogger, redactingTerminal } from '../src/io.ts';
import { realKubernetes } from '../src/kubernetes.ts';
import { Redactor } from '../src/redactor.ts';
import { spawnExec } from '../src/ship/exec.ts';
import { priceFor } from '../src/console/data.ts';
import { judge } from '../src/evals/checks.ts';
import { deleteCluster } from '../src/evals/cluster.ts';
import { modelProblem } from '../src/evals/investigate.ts';
import { reportMarkdown, reportName, totalsOf, type EvalReport } from '../src/evals/report.ts';
import { loadScenarios } from '../src/evals/scenario.ts';
import { runSuite } from '../src/evals/suite.ts';

/**
 * pnpm eval --provider <p> --model <id> (L3): every scenario in evals/scenarios on a
 * throwaway kind cluster, investigated read-only by the real agent, checked without a model,
 * reported in evals/reports. Needs Docker and kind; the model key comes from the environment.
 */
const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    model: { type: 'string' },
    set: { type: 'string', multiple: true },
    only: { type: 'string' },
    keep: { type: 'boolean' },
    out: { type: 'string' },
  },
});

const redactor = new Redactor();
const term = redactingTerminal({ stdout: process.stdout, stderr: process.stderr }, redactor);
const fields = Object.fromEntries(
  (values.set ?? []).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  }),
);
const choice = { provider: values.provider ?? '', model: values.model ?? '', fields };
const problem = modelProblem(choice, process.env);
if (problem) {
  term.err(
    `pnpm eval --provider <anthropic|openai|azure-openai|bedrock|ollama> --model <id>: ${problem}.`,
  );
  process.exit(2);
}

const KIND = process.env['KIND'] ?? 'kind';
const CLUSTER = 'kodra-agent-eval';
// On Windows, stay on the working drive: kodra-agent.yaml file references are POSIX paths.
const base =
  process.platform === 'win32'
    ? join(process.cwd(), 'node_modules', '.cache', 'kodra-eval')
    : tmpdir();
mkdirSync(base, { recursive: true });
const workDir = mkdtempSync(join(base, 'run-'));
const posix = (p: string) => (process.platform === 'win32' ? p.slice(2).replaceAll('\\', '/') : p);
const reportsDir = values.out ?? join(process.cwd(), '..', '..', 'evals', 'reports');

const startedAt = new Date().toISOString();
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

let code = 1;
try {
  const scenarios = await loadScenarios(values.only?.split(',').map((s) => s.trim()));
  const price = priceFor(`${choice.provider}/${choice.model}`, undefined);
  const results: EvalReport['scenarios'] = [];
  const runs = await runSuite(
    {
      model: choice,
      scenarios,
      cluster: CLUSTER,
      kind: KIND,
      exec: spawnExec,
      internal: false,
      workDir,
      configPath: posix,
      onRun: (run) => {
        const r = judge(run, price?.price);
        results.push(r);
        term.out(
          `${r.passed ? 'PASS' : 'FAIL'}  ${r.id}: ${r.rootCause ? 'right root cause' : 'missed the root cause'}, ${String(r.steps)} steps${r.violations.length > 0 ? `, ${String(r.violations.length)} must-not` : ''}`,
        );
      },
    },
    {
      term,
      log: jsonLogger(() => undefined, redactor),
      redactor,
      prompter: null,
      env: process.env,
      fetch: globalThis.fetch,
      kubernetes: realKubernetes,
      platform: process.platform,
      probeTimeoutMs: 10_000,
    },
  );
  if (runs) {
    const report: EvalReport = {
      kind: 'kodra-agent-eval',
      version: 1,
      startedAt,
      commit,
      agentVersion: AGENT_VERSION,
      provider: choice.provider,
      model: choice.model,
      pricing: price ? `${price.source}${price.asOf ? ` (prices as of ${price.asOf})` : ''}` : null,
      scenarios: results,
      totals: totalsOf(results),
    };
    mkdirSync(reportsDir, { recursive: true });
    const name = reportName(report);
    // Reports hold model answers: they pass the redactor like everything else.
    writeFileSync(
      join(reportsDir, `${name}.json`),
      `${redactor.redact(JSON.stringify(report, null, 2))}\n`,
    );
    writeFileSync(join(reportsDir, `${name}.md`), redactor.redact(reportMarkdown(report)));
    const t = report.totals;
    term.out(
      `${String(t.passed)} of ${String(t.total)} passed. Report: ${join(reportsDir, `${name}.md`)}`,
    );
    code = 0;
  }
} catch (error) {
  term.err(error instanceof Error ? error.message : String(error));
} finally {
  if (!values.keep) await deleteCluster(spawnExec, KIND, CLUSTER).catch(() => false);
}
process.exitCode = code;
