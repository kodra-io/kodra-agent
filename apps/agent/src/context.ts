import type { ModelConfig } from '@kodra-agent/schema';
import type { LanguageModel } from 'ai';
import type { Limits } from './agent.ts';
import type { Logger, Prompter, Terminal } from './io.ts';
import type { KubernetesFactory } from './kubernetes.ts';
import type { HostOptions } from './mcp/host.ts';
import type { ProbeContext } from './probes.ts';
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
}

export const AGENT_NAMESPACE = 'kodra-agent';
