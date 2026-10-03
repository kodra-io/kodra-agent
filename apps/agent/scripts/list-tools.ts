import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

// Dev helper for classifying a server's tools:
//   node scripts/list-tools.ts [KEY=VALUE ...] -- <command> [args...]
// Prints each tool with the server's own read-only / destructive hints.
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const envPairs = split === -1 ? [] : argv.slice(0, split);
const [command, ...args] = split === -1 ? argv : argv.slice(split + 1);
if (!command) throw new Error('usage: list-tools.ts [KEY=VALUE ...] -- <command> [args...]');

const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const pair of envPairs) {
  const at = pair.indexOf('=');
  env[pair.slice(0, at)] = pair.slice(at + 1);
}

const client = new Client({ name: 'kodra-agent-list-tools', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
const { tools } = await client.listTools();
for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
  const hints = tool.annotations ?? {};
  const flags = [
    hints.readOnlyHint === true ? 'readOnly' : '',
    hints.destructiveHint === true ? 'destructive' : '',
  ]
    .filter(Boolean)
    .join(',');
  const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).join(
    ',',
  );
  console.log(`${tool.name}\t${flags || '-'}\t[${props}]`);
}
console.log(`${String(tools.length)} tools`);
await client.close();
