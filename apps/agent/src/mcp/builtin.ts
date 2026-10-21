import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BuiltinRuntime } from '@kodra-agent/schema';
import type { CheckDeps } from '../databases/health.ts';
import { databaseEntries, databasesServer } from '../databases/server.ts';
import type { ConnectorInput } from './host.ts';

/** Test overrides for the servers that run inside the agent. */
export interface BuiltinDeps {
  databases?: Partial<CheckDeps>;
}

/** The MCP server for a `builtin` runtime, given only its own connector's settings and secrets. */
export function builtinServer(
  module: BuiltinRuntime['module'],
  input: ConnectorInput,
  deps: BuiltinDeps = {},
): McpServer {
  const servers: Record<BuiltinRuntime['module'], () => McpServer> = {
    databases: () =>
      databasesServer(databaseEntries(input.component.settings, input.secrets), deps.databases),
  };
  return servers[module]();
}
