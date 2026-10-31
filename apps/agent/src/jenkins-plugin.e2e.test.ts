import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getConnector } from '@kodra-agent/connectors';
import { afterEach, describe, expect, it } from 'vitest';
import type { Component } from './config.ts';
import { jsonLogger } from './io.ts';
import { ConnectorHost } from './mcp/host.ts';
import { decide } from './policy.ts';
import { Redactor } from './redactor.ts';

/**
 * The Jenkins connector on a real Jenkins with the official MCP Server plugin
 * (docker/test/jenkins-mcp): every tool the plugin offers is classified or hidden, and the
 * agent reads jobs through it. A plugin upgrade that adds a tool fails here instead of
 * silently hiding it. Run with KODRA_JENKINS_MCP_URL, _USER, and _TOKEN; CI starts the image.
 */
const url = process.env['KODRA_JENKINS_MCP_URL'];
const user = process.env['KODRA_JENKINS_MCP_USER'] ?? 'kodra';
const token = process.env['KODRA_JENKINS_MCP_TOKEN'] ?? '';

let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

describe.skipIf(!url)('Jenkins MCP Server plugin', () => {
  const manifest = getConnector('jenkins');
  if (!manifest) throw new Error('no jenkins connector');
  const settings = { url, username: user, jobs: ['team-a'] };

  it('offers only tools the manifest classifies or hides', { timeout: 60_000 }, async () => {
    const client = new Client({ name: 'kodra-agent-e2e', version: '0' });
    const auth = Buffer.from(`${user}:${token}`).toString('base64');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url ?? ''}/mcp-server/mcp`), {
        requestInit: { headers: { Authorization: `Basic ${auth}` } },
      }) as unknown as Transport,
    );
    try {
      const offered = (await client.listTools()).tools.map((t) => t.name);
      const known = new Set([...Object.keys(manifest.tools), ...(manifest.hiddenTools ?? [])]);
      expect(offered.length).toBeGreaterThan(0);
      expect(
        offered.filter((t) => !known.has(t)),
        'tools the manifest does not classify',
      ).toEqual([]);
      // Every classified tool still exists, so no guard protects a tool that is gone.
      expect(Object.keys(manifest.tools).filter((t) => !offered.includes(t))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('reads the listed jobs through the host, and only those', { timeout: 60_000 }, async () => {
    const redactor = new Redactor();
    redactor.add(token);
    const component: Component = {
      id: 'jenkins',
      displayName: manifest.displayName,
      manifest,
      settings,
      secrets: [],
    };
    host = await ConnectorHost.start([{ component, access: 'read-only', secrets: { token } }], {
      redactor,
      log: jsonLogger(() => undefined, redactor),
      env: {},
    });
    expect(host.failures()).toEqual([]);
    const names = host.tools().map((t) => t.tool);
    expect(names).toContain('getJob');
    for (const hidden of manifest.hiddenTools ?? []) expect(names).not.toContain(hidden);

    const job = JSON.parse(
      (await host.call('jenkins__getJob', { jobFullName: 'team-a/deploy-web' })).text,
    ) as { result?: { fullName?: string } };
    expect(job.result?.fullName).toBe('team-a/deploy-web');
    const folder = (await host.call('jenkins__getJobs', { parentFullName: 'team-a' })).text;
    expect(folder).toContain('team-a/deploy-web');

    // A job outside the list never reaches the server.
    const tool = host.tools().find((t) => t.tool === 'getJob');
    if (!tool) throw new Error('getJob');
    expect(
      decide({
        risk: tool.risk,
        access: 'read-only',
        destructiveActions: 'deny',
        guards: manifest.guards?.['getJob'] ?? [],
        args: { jobFullName: 'other' },
        settings,
      }).kind,
    ).toBe('block');
  });
});
