import { join } from 'node:path';
import type { Context } from '../context.ts';
import { writePrivateFile } from '../env-file.ts';
import type { Exec } from '../ship/exec.ts';
import type { ScenarioRun } from './checks.ts';
import {
  agentKubeconfig,
  applyAll,
  createCluster,
  waitReady,
  waitRollout,
  type KindCluster,
} from './cluster.ts';
import { evalConfigYaml, investigate, type ModelChoice } from './investigate.ts';
import type { Scenario } from './scenario.ts';

/**
 * One pass over scenarios (L3), shared by `pnpm eval` and `kodra-agent demo`: a kind cluster
 * with every scenario's workload, a read-only service account for the agent, then one
 * investigation per scenario.
 */

export interface SuiteOptions {
  model: ModelChoice;
  scenarios: readonly Scenario[];
  cluster: string;
  kind: string;
  exec: Exec;
  /** True inside a container on kind's Docker network (the demo). */
  internal: boolean;
  /** A private folder for the agent's config, kubeconfig, and audit log. */
  workDir: string;
  /** How kodra-agent.yaml spells a local path (POSIX, without a Windows drive letter). */
  configPath?: (path: string) => string;
  readyTimeoutMs?: number;
  onCluster?: (cluster: KindCluster) => Promise<void> | void;
  onRun?: (run: ScenarioRun) => void;
}

export async function prepareScenarios(
  admin: string,
  scenarios: readonly Scenario[],
  timeoutMs: number,
): Promise<void> {
  await applyAll(
    admin,
    scenarios.flatMap((s) => s.manifests),
  );
  await Promise.all(
    scenarios.map(async (s) => {
      await waitReady(admin, s, timeoutMs);
      if (s.updates.length === 0) return;
      // A new release: roll it out, and wait until only the new pods are left.
      await applyAll(admin, s.updates);
      await waitRollout(admin, s.id, timeoutMs);
      await waitReady(admin, s, timeoutMs);
    }),
  );
}

export async function runSuite(opts: SuiteOptions, ctx: Context): Promise<ScenarioRun[] | null> {
  const posix = opts.configPath ?? ((p: string) => p);
  ctx.term.out(`Preparing kind cluster ${opts.cluster}.`);
  const cluster = await createCluster(opts.exec, opts.kind, opts.cluster, opts.internal);
  await opts.onCluster?.(cluster);
  ctx.term.out(
    `Starting ${String(opts.scenarios.length)} broken workload${opts.scenarios.length === 1 ? '' : 's'} and waiting for each to fail.`,
  );
  await prepareScenarios(cluster.admin, opts.scenarios, opts.readyTimeoutMs ?? 300_000);

  const ids = opts.scenarios.map((s) => s.id);
  const kubeconfig = join(opts.workDir, 'agent-kubeconfig');
  const text = await agentKubeconfig(cluster.admin, ids);
  // The service account token is a secret like any other: it never reaches output.
  const token = (JSON.parse(text) as { users: { user: { token?: string } }[] }).users[0]?.user
    .token;
  if (token) ctx.redactor.add(token);
  await writePrivateFile(kubeconfig, text);
  const configFile = join(opts.workDir, 'kodra-agent.yaml');
  await writePrivateFile(
    configFile,
    evalConfigYaml({
      name: 'kodra-eval',
      model: opts.model,
      namespaces: ids,
      kubeconfigPath: posix(kubeconfig),
      auditPath: posix(join(opts.workDir, 'audit', 'audit.jsonl')),
    }),
  );
  return investigate(configFile, opts.scenarios, ctx, opts.onRun);
}
