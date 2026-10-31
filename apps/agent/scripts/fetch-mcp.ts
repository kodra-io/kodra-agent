import { connectors } from '@kodra-agent/connectors';
import { allVariants, stdioRuntimes } from '@kodra-agent/schema';
import { fetchServer, mcpCacheDir } from '../src/mcp/fetch.ts';

// Downloads every pinned MCP server binary for this platform, checksum-verified.
const dir = mcpCacheDir();
let failed = false;
// Every server a connector can use, so a community fallback works offline too (B4).
for (const manifest of connectors.flatMap(allVariants)) {
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
