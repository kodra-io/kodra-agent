/**
 * Runs inside the agent image in the proxy test (PLAN-v0.2 M12): git and helm, which `ship`
 * runs, reach the stand-in services through the proxy with the extra CA, using exactly the
 * environment the agent gives its child processes.
 */
import { spawnSync } from 'node:child_process';
import type { AgentConfig } from '@kodra-agent/schema';
import { applyNetwork, networkSettings } from '../src/network.ts';
import { Redactor } from '../src/redactor.ts';

const config = {
  spec: {
    network: {
      proxy: { https: '${env:HTTPS_PROXY}' },
      caBundleFile: '/etc/kodra-agent/ca/ca.pem',
    },
  },
} as unknown as AgentConfig;

const applied = await applyNetwork(networkSettings(config, process.env), new Redactor());
if (applied.problems.length > 0) throw new Error(applied.problems.join('; '));
const env: Record<string, string | undefined> = {
  ...process.env,
  ...applied.childEnv,
  HOME: '/tmp',
  HELM_CACHE_HOME: '/tmp/helm/cache',
  HELM_CONFIG_HOME: '/tmp/helm/config',
  HELM_DATA_HOME: '/tmp/helm/data',
};

for (const [what, cmd, args] of [
  ['git', 'git', ['ls-remote', 'https://git.test/repo.git']],
  ['helm', 'helm', ['repo', 'add', 'stub', 'https://charts.test']],
] as const) {
  const result = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) {
    process.stderr.write(`${what} failed through the proxy:\n${result.stdout}${result.stderr}\n`);
    process.exit(1);
  }
  process.stdout.write(`${what}: reached its stand-in through the proxy\n`);
}
