import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnector } from '@kodra-agent/connectors';
import type { AccessLevel } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.ts';
import type { Component } from './config.ts';
import { jsonLogger } from './io.ts';
import { ConnectorHost, type ConnectorInput } from './mcp/host.ts';
import { Redactor } from './redactor.ts';
import { tempDir } from './test-helpers.ts';

/**
 * Starts each pinned, real MCP server through the host with dummy credentials (no API
 * calls are made: only tools/list) and checks that every tool it offers is classified.
 * A server upgrade that adds a tool fails here instead of silently hiding it. Run with
 * KODRA_REAL_SERVERS=1 after `pnpm mcp:fetch` (needs uvx and npx). Kubernetes is covered
 * by the kind test.
 */
const enabled = process.env['KODRA_REAL_SERVERS'] === '1';

const CASES: {
  id: string;
  access: AccessLevel;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}[] = [
  {
    id: 'github',
    access: 'read-write-approved',
    settings: { repos: ['acme/api'] },
    secrets: { token: 'ghp_dummy_not_used' },
  },
  { id: 'github-actions', access: 'read-write-approved', settings: {}, secrets: {} },
  {
    id: 'gitlab',
    access: 'read-write-approved',
    settings: { url: 'http://127.0.0.1:1', projects: ['acme/api'] },
    secrets: { token: 'glpat-dummy-not-used' },
  },
  { id: 'gitlab-ci', access: 'read-write-approved', settings: {}, secrets: {} },
  {
    id: 'grafana',
    access: 'read-only',
    settings: { url: 'http://127.0.0.1:1' },
    secrets: { serviceAccountToken: 'dummy' },
  },
  { id: 'prometheus', access: 'read-only', settings: { url: 'http://127.0.0.1:1' }, secrets: {} },
  {
    id: 'aws',
    access: 'read-only',
    settings: { region: 'eu-central-1' },
    secrets: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'dummy-not-used' },
  },
];

function component(id: string, settings: Record<string, unknown>): Component {
  const manifest = getConnector(id);
  if (!manifest) throw new Error(id);
  return { id, displayName: manifest.displayName, manifest, settings, secrets: [] };
}

describe.skipIf(!enabled)('real MCP servers', () => {
  it.each(CASES)(
    '$id offers only classified tools',
    { timeout: 300_000 },
    async ({ id, access, settings, secrets }) => {
      const redactor = new Redactor();
      const auditPath = join(await tempDir(), 'audit.jsonl');
      const input: ConnectorInput = { component: component(id, settings), access, secrets };
      const parent = id === 'github-actions' ? CASES[0] : id === 'gitlab-ci' ? CASES[2] : undefined;
      if (parent) {
        input.sharedSecrets = { [parent.id]: parent.secrets };
        input.sharedSettings = { [parent.id]: parent.settings };
      }
      const host = await ConnectorHost.start([input], {
        redactor,
        log: jsonLogger(() => undefined, redactor),
        audit: new AuditLog(auditPath, redactor),
        env: process.env,
      });
      try {
        const tools = host.tools();
        expect(tools.length, id).toBeGreaterThan(0);
        const audit = await readFile(auditPath, 'utf8').catch(() => '');
        const unclassified = audit
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { tool?: string; risk?: string })
          .filter((r) => r.risk === 'unclassified')
          .map((r) => r.tool);
        expect(unclassified, `${id} offers tools its manifest does not classify`).toEqual([]);
        // Tools that must never reach the model, under any connector.
        const neverExposed = [
          'merge_pull_request',
          'pull_request_review_write',
          'merge_merge_request',
          'approve_merge_request',
          'update_default_branch',
          'execute_graphql',
          'get_pipeline_variables',
          'get_pipeline_schedule_variable',
          'get_pod_logs',
          'configuration_view',
        ];
        expect(
          tools.filter((t) => neverExposed.includes(t.tool)).map((t) => t.tool),
          id,
        ).toEqual([]);
      } finally {
        await host.close();
      }
    },
  );
});
