import { getModelProvider } from '@kodra-agent/connectors';
import { stringify } from 'yaml';
import { runTurn } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import { readAudit } from '../console/data.ts';
import type { Context } from '../context.ts';
import { investigationPrompt } from '../monitoring/monitor.ts';
import { startRuntime } from '../runtime.ts';
import type { ScenarioRun } from './checks.ts';
import type { Scenario } from './scenario.ts';

/**
 * Runs read-only investigations of scenarios with the real runtime (L3): the same agent loop,
 * policy, redactor, and Kubernetes MCP server as `kodra-agent run`, against the user's model.
 */

export interface ModelChoice {
  provider: string;
  model: string;
  /** Provider settings, like baseUrl for Ollama or region for Bedrock. */
  fields?: Readonly<Record<string, string>>;
  /** Secret references from a kodra-agent.yaml, like ${env:MY_KEY}; else the usual env var. */
  secrets?: Readonly<Record<string, string>>;
}

/** Investigations cannot change anything, so nothing is ever approved. */
const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'evaluation' }),
};

/** Why a model choice cannot run, or null. Secrets come from the environment only. */
export function modelProblem(
  choice: ModelChoice,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const manifest = getModelProvider(choice.provider);
  if (!manifest) return `unknown provider ${choice.provider}`;
  if (!choice.model.trim()) return 'give a model id with --model';
  for (const f of manifest.configFields) {
    if (f.required && !('default' in f && f.default !== undefined) && !choice.fields?.[f.key]) {
      return `${manifest.displayName} needs ${f.key}: pass --set ${f.key}=<value>`;
    }
  }
  for (const s of manifest.secrets) {
    if (s.required && s.envVar && !choice.secrets?.[s.key] && !env[s.envVar]) {
      return `${manifest.displayName} needs ${s.envVar} in the environment`;
    }
  }
  return null;
}

/** A kodra-agent.yaml for the investigations: one read-only Kubernetes connector and the model. */
export function evalConfigYaml(opts: {
  name: string;
  model: ModelChoice;
  namespaces: readonly string[];
  kubeconfigPath: string;
  auditPath: string;
}): string {
  const manifest = getModelProvider(opts.model.provider);
  if (!manifest) throw new Error(`unknown provider ${opts.model.provider}`);
  const model: Record<string, unknown> = { provider: manifest.id, name: opts.model.model };
  for (const f of manifest.configFields) {
    const value = opts.model.fields?.[f.key];
    if (value !== undefined) model[f.key] = value;
  }
  for (const s of manifest.secrets) {
    const ref = opts.model.secrets?.[s.key] ?? (s.envVar ? `\${env:${s.envVar}}` : undefined);
    if (ref) model[s.key] = ref;
  }
  return stringify({
    apiVersion: 'kodra.io/v1alpha1',
    kind: 'Agent',
    metadata: { name: opts.name },
    spec: {
      target: 'compose',
      model,
      connectors: {
        kubernetes: {
          enabled: true,
          access: 'read-only',
          config: { namespaces: [...opts.namespaces] },
          secrets: { kubeconfig: `\${file:${opts.kubeconfigPath}}` },
        },
      },
      // Nobody approves anything: investigations are read-only.
      policy: { approvals: { approvers: ['U0KODRAEVAL'] } },
      console: { enabled: false },
      audit: { path: opts.auditPath },
    },
  });
}

/** What the agent is asked: the scenario's question, or the prompt `run` builds for an alert. */
export function triggerText(scenario: Scenario): string {
  if ('question' in scenario.trigger) return scenario.trigger.question;
  const { labels, annotations } = scenario.trigger.alert;
  return investigationPrompt({
    fingerprint: scenario.id,
    name: labels['alertname'] ?? scenario.id,
    severity: labels['severity'] ?? 'warning',
    labels,
    annotations,
    startsAt: new Date().toISOString(),
  });
}

/** Investigates each scenario in turn, each in a fresh conversation, read-only. */
export async function investigate(
  configPath: string,
  scenarios: readonly Scenario[],
  ctx: Context,
  onRun?: (run: ScenarioRun) => void,
): Promise<ScenarioRun[] | null> {
  const runtime = await startRuntime(configPath, ctx);
  if (!runtime) return null;
  const runs: ScenarioRun[] = [];
  try {
    const failed = runtime.host.failures();
    if (failed.length > 0) {
      for (const f of failed) ctx.term.err(`${f.displayName} did not start: ${f.reason}`);
      return null;
    }
    const deps = { ...runtime.deps(refuseAll), readOnly: true };
    for (const scenario of scenarios) {
      const task = `eval-${scenario.id}`;
      const started = Date.now();
      let answer = '';
      let stoppedBy: string | undefined;
      let error: string | undefined;
      try {
        const result = await runTurn(deps, [], triggerText(scenario), task);
        answer = result.text;
        stoppedBy = result.stoppedBy;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const durationMs = Date.now() - started;
      // Records are written in order: once this one is written, the run's are too.
      await runtime.audit.append({
        event: 'result',
        actor: 'agent',
        task,
        detail: 'evaluation run done',
      });
      const records = (await readAudit(runtime.audit.path)).filter((r) => r.task === task);
      const run: ScenarioRun = {
        scenario,
        answer: ctx.redactor.redact(answer),
        records,
        durationMs,
        stoppedBy,
        ...(error ? { error: ctx.redactor.redact(error) } : {}),
      };
      runs.push(run);
      onRun?.(run);
    }
    return runs;
  } finally {
    await runtime.close();
  }
}
