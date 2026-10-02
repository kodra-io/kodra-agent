import { SCHEMA_API_VERSION } from '@kodra-agent/schema';
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

const COMMANDS = [
  ['init', 'Ask for the secrets your enabled connectors need and store them locally'],
  ['doctor', 'Check config, secrets, and connector access'],
  ['run', 'Start the agent service'],
  ['chat', 'Chat with the agent in this terminal'],
  ['ship <repo>', 'Build, containerize, package, and open a PR for a repo'],
] as const;

export function helpText(): string {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  const lines = COMMANDS.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}`);
  return [
    `kodra-agent ${VERSION} (config ${SCHEMA_API_VERSION})`,
    '',
    'Usage: kodra-agent <command> [options]',
    '',
    'Commands (not implemented yet):',
    ...lines,
    '',
    'Options:',
    '  -h, --help     Show this help',
    '  -v, --version  Show the version',
  ].join('\n');
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCli(argv: readonly string[]): CliResult {
  const [first] = argv;
  if (first === undefined || first === '-h' || first === '--help') {
    return { exitCode: 0, stdout: helpText(), stderr: '' };
  }
  if (first === '-v' || first === '--version') {
    return { exitCode: 0, stdout: VERSION, stderr: '' };
  }
  const known = COMMANDS.some(([name]) => name.split(' ')[0] === first);
  const reason = known ? `'${first}' is not implemented yet.` : `Unknown command '${first}'.`;
  return { exitCode: 1, stdout: '', stderr: `${reason} Run 'kodra-agent --help'.` };
}
