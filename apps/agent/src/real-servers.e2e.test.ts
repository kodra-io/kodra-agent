import { describe, expect, it } from 'vitest';
import { checkServer, DUMMY_CASES } from './mcp/check.ts';

/**
 * Starts each pinned, real MCP server through the host with dummy credentials (no API
 * calls are made: only tools/list) and checks that every tool it offers is classified.
 * A server upgrade that adds a tool fails here instead of silently hiding it. Run with
 * KODRA_REAL_SERVERS=1 after `pnpm mcp:fetch` (needs uvx and npx). Kubernetes is covered
 * by the kind test. The agent image runs the same check on its preinstalled servers
 * (scripts/check-servers.ts).
 */
const enabled = process.env['KODRA_REAL_SERVERS'] === '1';

describe.skipIf(!enabled)('real MCP servers', () => {
  it.each(DUMMY_CASES)('$id offers only classified tools', { timeout: 300_000 }, async (c) => {
    const result = await checkServer(c, { env: process.env });
    expect(result.tools, c.id).toBeGreaterThan(0);
    expect(result.unclassified, `${c.id} offers tools its manifest does not classify`).toEqual([]);
    expect(result.exposed, c.id).toEqual([]);
  });
});
