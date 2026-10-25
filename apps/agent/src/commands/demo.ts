import { getModelProvider } from '@kodra-agent/connectors';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { selfNames } from '../console/config-backend.ts';
import { priceFor } from '../console/data.ts';
import type { Context } from '../context.ts';
import { spawnExec } from '../ship/exec.ts';
import { judge } from '../evals/checks.ts';
import { deleteCluster } from '../evals/cluster.ts';
import { modelProblem, type ModelChoice } from '../evals/investigate.ts';
import { totalsOf } from '../evals/report.ts';
import { loadScenarios } from '../evals/scenario.ts';
import { runSuite } from '../evals/suite.ts';

/**
 * `kodra-agent demo` (L3): three broken workloads on a throwaway kind cluster, each
 * investigated read-only with your own model key, and the findings printed. It runs as a
 * one-shot container with the Docker socket, never inside the always-on agent.
 */

export const DEMO_CLUSTER = 'kodra-agent-demo';
export const DEMO_SCENARIOS = ['missing-env', 'oomkilled', 'bad-image-tag'] as const;

export interface DemoOptions {
  configPath: string;
  /** Whether --config was given, so its model is used even when --provider is not. */
  provider?: string | undefined;
  model?: string | undefined;
  fields: Readonly<Record<string, string>>;
  cleanup: boolean;
}

/** The model from --provider/--model, or from kodra-agent.yaml's spec.model. */
async function modelChoice(opts: DemoOptions): Promise<ModelChoice | string> {
  if (opts.provider || opts.model) {
    return { provider: opts.provider ?? '', model: opts.model ?? '', fields: opts.fields };
  }
  const loaded = await loadConfig(opts.configPath).catch(() => null);
  if (!loaded?.ok) {
    return 'give a model with --provider <name> --model <id>, or --config with a kodra-agent.yaml';
  }
  const { provider, name, ...rest } = loaded.config.spec.model as unknown as Record<
    string,
    unknown
  >;
  const manifest = getModelProvider(String(provider));
  const secretKeys = new Set(manifest?.secrets.map((s) => s.key) ?? []);
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value !== 'string') continue;
    if (secretKeys.has(key)) secrets[key] = value;
    else fields[key] = value;
  }
  return {
    provider: String(provider),
    model: String(name),
    fields: { ...fields, ...opts.fields },
    secrets,
  };
}

export async function demo(opts: DemoOptions, ctx: Context): Promise<number> {
  if (selfNames(ctx.env)) {
    ctx.term.err(
      'The demo runs as a one-shot container with the Docker socket, never inside the agent itself. See the README.',
    );
    return 1;
  }
  const exec = ctx.exec ?? spawnExec;
  const kind = ctx.env['KIND'] ?? 'kind';
  if (opts.cleanup) {
    const removed = await deleteCluster(exec, kind, DEMO_CLUSTER);
    ctx.term.out(
      removed
        ? `Deleted the kind cluster ${DEMO_CLUSTER}.`
        : `There is no ${DEMO_CLUSTER} cluster.`,
    );
    return 0;
  }

  const choice = await modelChoice(opts);
  const problem = typeof choice === 'string' ? choice : modelProblem(choice, ctx.env);
  if (typeof choice === 'string' || problem !== null) {
    ctx.term.err(`kodra-agent demo: ${problem ?? 'no model'}.`);
    return 2;
  }
  // Inside a container, the cluster's API server is reached over kind's Docker network.
  const internal = ctx.env['KODRA_DEMO_INTERNAL'] === '1' || existsSync('/.dockerenv');
  const scenarios = await loadScenarios(DEMO_SCENARIOS);
  const price = priceFor(`${choice.provider}/${choice.model}`, undefined);
  const workDir = await mkdtemp(join(tmpdir(), 'kodra-demo-'));
  ctx.term.out(
    `Kodra AI Agent demo: ${String(scenarios.length)} broken workloads, investigated read-only with ${choice.provider}/${choice.model}.`,
  );
  const results: ReturnType<typeof judge>[] = [];
  try {
    const runs = await runSuite(
      {
        model: choice,
        scenarios,
        cluster: DEMO_CLUSTER,
        kind,
        exec,
        internal,
        workDir,
        onCluster: async () => {
          if (!internal) return;
          const joined = await exec('docker', ['network', 'connect', 'kind', hostname()]);
          if (joined.code !== 0 && !/already exists/i.test(joined.stderr)) {
            throw new Error(`could not join the kind network: ${joined.stderr.trim().slice(-300)}`);
          }
        },
        onRun: (run) => {
          const r = judge(run, price?.price);
          results.push(r);
          ctx.term.out('');
          ctx.term.out(`== ${r.title} (${r.id})`);
          ctx.term.out(r.answer || r.error || '(no answer)');
          ctx.term.out(
            `-> ${r.rootCause ? 'Found the root cause' : 'Missed part of the root cause'} in ${String(r.steps)} tool calls.`,
          );
        },
      },
      ctx,
    );
    if (!runs) return 1;
  } catch (error) {
    ctx.term.err(`The demo stopped: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const t = totalsOf(results);
  ctx.term.out('');
  ctx.term.out(
    `Found the root cause in ${String(t.rootCause)} of ${String(t.total)}. Tokens: ${String(t.tokens.input)} in, ${String(t.tokens.output)} out${t.costUsd === null ? '' : `, about $${t.costUsd.toFixed(4)}`}.`,
  );
  ctx.term.out(
    `The cluster ${DEMO_CLUSTER} is still running. Remove it with: kodra-agent demo --cleanup`,
  );
  return 0;
}
