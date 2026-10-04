import { checkServer, DUMMY_CASES } from '../src/mcp/check.ts';

// Starts every pinned MCP server with dummy credentials and lists its tools (no API calls).
// Run inside the agent image to prove the preinstalled servers start offline and offer only
// classified tools:  docker run --rm --entrypoint node <image> /app/apps/agent/scripts/check-servers.ts
let failed = false;
for (const c of DUMMY_CASES) {
  try {
    const result = await checkServer(c, { env: process.env });
    const problems = [
      ...(result.tools === 0 ? ['no tools'] : []),
      ...result.unclassified.map((t) => `unclassified tool ${t}`),
      ...result.exposed.map((t) => `exposed tool ${t}`),
    ];
    failed ||= problems.length > 0;
    console.log(
      `${c.id.padEnd(16)} ${String(result.tools).padStart(3)} tools${problems.length ? `  FAILED: ${problems.join(', ')}` : ''}`,
    );
  } catch (error) {
    failed = true;
    console.log(
      `${c.id.padEnd(16)} FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
