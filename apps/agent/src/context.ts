import type { Logger, Prompter, Terminal } from './io.ts';
import type { KubernetesFactory } from './kubernetes.ts';
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
}

export const AGENT_NAMESPACE = 'kodra-agent';
