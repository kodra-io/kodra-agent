import { connectors } from '@kodra-agent/connectors';
import { stdioRuntimes } from '@kodra-agent/schema';
import { fetchServer, mcpCacheDir } from '../src/mcp/fetch.ts';

// Downloads every pinned MCP server binary for this platform, checksum-verified.
const dir = mcpCacheDir();
let failed = false;
for (const manifest of connectors) {
  for (const runtime of stdioRuntimes(manifest)) {
    const label = `${manifest.id}${runtime.name ? `/${runtime.name}` : ''}`.padEnd(20);
    try {
      const result = await fetchServer(runtime, dir);
      console.log(
        `${label} ${result.status}${'path' in result ? ` ${result.path}` : ` (${result.reason})`}`,
      );
    } catch (error) {
      failed = true;
      console.error(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
