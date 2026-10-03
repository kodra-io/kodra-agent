import { connectors } from '@kodra-agent/connectors';
import { fetchServer, mcpCacheDir } from '../src/mcp/fetch.ts';

// Downloads every pinned MCP server binary for this platform, checksum-verified.
const dir = mcpCacheDir();
let failed = false;
for (const manifest of connectors) {
  if (manifest.runtime?.type !== 'mcp-stdio') continue;
  try {
    const result = await fetchServer(manifest, dir);
    console.log(
      `${manifest.id.padEnd(12)} ${result.status}${'path' in result ? ` ${result.path}` : ` (${result.reason})`}`,
    );
  } catch (error) {
    failed = true;
    console.error(
      `${manifest.id.padEnd(12)} FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
