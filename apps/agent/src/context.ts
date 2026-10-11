import type { ModelConfig } from '@kodra-agent/schema';
import type { LanguageModel } from 'ai';
import type { Limits } from './agent.ts';
import type { Logger, Prompter, Terminal } from './io.ts';
import type { SelfKubernetes } from './console/config-backend.ts';
import type { KubernetesFactory } from './kubernetes.ts';
import type { HostOptions } from './mcp/host.ts';
import type { ProbeContext } from './probes.ts';
import type { Exec } from './ship/exec.ts';
import type { SlackConnection } from './slack/api.ts';
import type { Redactor } from './redactor.ts';

/** Everything a command touches outside its own logic, injectable for tests. */
export interface Context {
  term: Terminal;
  log: Logger;
  redactor: Redactor;
  /** null when there is no terminal to ask questions on. */
  prompter: Prompter | null;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  kubernetes: KubernetesFactory;
  platform: NodeJS.Platform;
  probeTimeoutMs: number;
  endpoints?: ProbeContext['endpoints'];
  /** Builds the model; tests pass a mock. */
  modelFactory?: (model: ModelConfig, secrets: Readonly<Record<string, string>>) => LanguageModel;
  /** Starts MCP servers; tests run fake ones. */
  launcher?: HostOptions['launcher'];
  limits?: Limits;
  /** Connects to Slack; tests pass a fake. */
  slackConnection?: (botToken: string, appToken: string) => SlackConnection;
  /** Stops `run`; without it, SIGTERM and SIGINT do. */
  stopSignal?: AbortSignal;
  /** Port for /healthz and /readyz (0 picks a free port). */
  healthPort?: number;
  /** Called once `run` is ready, with the health server's port (tests). */
  onReady?: (info: { healthPort: number; consolePort?: number }) => void;
  /** Port for the console (0 picks a free port); defaults to spec.console.port. */
  consolePort?: number;
  /** Where the built console is (tests). */
  consoleStaticDir?: string;
  /** Runs git, docker, and helm for `ship`; tests pass a fake. */
  exec?: Exec;
  /** Clone address for a repo (tests point it at a local bare repo). */
  gitRemote?: (provider: 'github' | 'gitlab', repo: string) => string;
  /** How long `ship` waits for the container to answer. */
  shipSmokeTimeoutMs?: number;
  /** The agent's own container id (null on a host); detected when not set. */
  selfContainer?: string | null;
  /** The agent's access to its own ConfigMap, Secret, and Deployment (tests pass a fake). */
  selfKubernetes?: () => SelfKubernetes;
}

export const AGENT_NAMESPACE = 'kodra-agent';
