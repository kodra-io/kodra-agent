import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redactor } from '../redactor.ts';
import type { Exec, ExecResult } from '../ship/exec.ts';

/** The Kubernetes connector's credentials, as resolved from its secrets. */
export interface ClusterCredentials {
  kubeconfig?: string | undefined;
}

export interface Helm {
  run(args: readonly string[], timeoutMs?: number): Promise<ExecResult>;
  /** Removes the kubeconfig copy. */
  close(): Promise<void>;
}

/**
 * Helm for the sandbox (B2): the connector's kubeconfig in a 0600 temp file (never an
 * argument), and release records in ConfigMaps so the agent never needs Secrets. Output comes
 * back redacted.
 */
export async function sandboxHelm(opts: {
  exec: Exec;
  redactor: Redactor;
  credentials: ClusterCredentials;
  networkEnv: Readonly<Record<string, string>>;
}): Promise<Helm> {
  const dir = await mkdtemp(join(tmpdir(), 'kodra-sandbox-'));
  const env: Record<string, string> = {
    ...opts.networkEnv,
    HELM_DRIVER: 'configmap',
    // Helm's caches and repo config stay out of the user's home.
    HELM_CACHE_HOME: join(dir, 'cache'),
    HELM_CONFIG_HOME: join(dir, 'config'),
    HELM_DATA_HOME: join(dir, 'data'),
  };
  if (opts.credentials.kubeconfig) {
    const path = join(dir, 'kubeconfig');
    await writeFile(path, opts.credentials.kubeconfig, { mode: 0o600 });
    env['KUBECONFIG'] = path;
  }
  return {
    async run(args, timeoutMs = 6 * 60_000) {
      const r = await opts.exec('helm', args, { env, timeoutMs, cwd: dir });
      return {
        code: r.code,
        stdout: opts.redactor.redact(r.stdout),
        stderr: opts.redactor.redact(r.stderr),
      };
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
