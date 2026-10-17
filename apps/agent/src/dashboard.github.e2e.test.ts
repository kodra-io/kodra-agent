import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnector } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.ts';
import { ConnectorDashboard, type RunsData } from './dashboard.ts';
import { jsonLogger } from './io.ts';
import { component } from './mcp/check.ts';
import { ConnectorHost } from './mcp/host.ts';
import { Redactor } from './redactor.ts';

/**
 * The GitHub Actions card on real output: the pinned github-mcp-server lists this repo's
 * workflow runs with CI's own token. Run with KODRA_DASHBOARD_GITHUB=1 and GITHUB_TOKEN set,
 * after `pnpm mcp:fetch`. Kubernetes cards are tested on recorded kind output.
 */
const token = process.env['GITHUB_TOKEN'];
const enabled = process.env['KODRA_DASHBOARD_GITHUB'] === '1' && Boolean(token);

describe.skipIf(!enabled)('dashboard on real GitHub output', () => {
  it('reads this repo workflow runs', { timeout: 120_000 }, async () => {
    const manifest = getConnector('github-actions');
    if (!manifest || !token) throw new Error('unreachable');
    const redactor = new Redactor();
    redactor.add(token);
    const dir = await mkdtemp(join(tmpdir(), 'kodra-dash-'));
    const github = { repos: ['kodra-io/kodra-agent'] };
    const host = await ConnectorHost.start(
      [
        {
          component: component('github-actions', {}),
          access: 'read-only',
          secrets: {},
          sharedSecrets: { github: { token } },
          sharedSettings: { github },
        },
      ],
      {
        redactor,
        log: jsonLogger(() => undefined, redactor),
        audit: new AuditLog(join(dir, 'audit.jsonl'), redactor),
        env: process.env,
      },
    );
    try {
      const view = await new ConnectorDashboard({
        host,
        redactor,
        policy: { destructiveActions: 'deny', self: null },
        manifests: [manifest],
      }).view();
      const result = view.connectors[0]?.panels[0]?.results[0];
      expect(result?.error).toBeUndefined();
      const data = result?.data as RunsData;
      expect(data.kind).toBe('runs');
      expect(data.runs.length).toBeGreaterThan(0);
      for (const run of data.runs) {
        expect(run.url).toMatch(/^https:\/\/github\.com\/kodra-io\/kodra-agent\/actions\/runs\//);
        expect(run.ref).not.toBe('');
      }
      const counted = Object.values(data.counts).reduce((a, b) => a + b, 0);
      expect(counted).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });
});
