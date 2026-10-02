import { parseArgs } from 'node:util';
import { SCHEMA_API_VERSION } from '@kodra-agent/schema';
import pkg from '../package.json' with { type: 'json' };
import { doctor } from './commands/doctor.ts';
import { init } from './commands/init.ts';
import { configPath } from './config.ts';
import type { Context } from './context.ts';

export const VERSION: string = pkg.version;

const COMMANDS = [
  ['init', 'Ask for the secrets your config needs, check them, and store them locally'],
  ['doctor', 'Check the config, secrets, connector access, and audit log'],
  ['run', 'Start the agent service (not implemented yet)'],
  ['chat', 'Chat with the agent in this terminal (not implemented yet)'],
  ['ship <repo>', 'Build, containerize, package, and open a PR (not implemented yet)'],
] as const;

export function helpText(): string {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  return [
    `kodra-agent ${VERSION} (config ${SCHEMA_API_VERSION})`,
    '',
    'Usage: kodra-agent <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}`),
    '',
    'Options:',
    '  --config <path>        kodra-agent.yaml (default: $KODRA_AGENT_CONFIG or ./kodra-agent.yaml)',
    '  -h, --help             Show this help',
    '  -v, --version          Show the version',
    '',
    'init options:',
    '  --target <compose|kubernetes>  Where to store secrets (default: spec.target)',
    '  --namespace <name>             Kubernetes namespace for the Secret (default: kodra-agent)',
    '  --non-interactive              Read values from the environment instead of asking',
    '  --dry-run                      Kubernetes: print the Secret manifest with placeholders',
    '',
    'doctor options:',
    '  --json                         Print the results as JSON',
  ].join('\n');
}

const OPTIONS = {
  config: { type: 'string' },
  target: { type: 'string' },
  namespace: { type: 'string' },
  'non-interactive': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** Runs the CLI and returns the exit code. All output goes through ctx.term (redacted). */
export async function main(argv: readonly string[], ctx: Context): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    ctx.term.err(
      `${error instanceof Error ? error.message : 'Invalid arguments.'} Run 'kodra-agent --help'.`,
    );
    return 2;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;

  if (values.version) {
    ctx.term.out(VERSION);
    return 0;
  }
  if (values.help || command === undefined) {
    ctx.term.out(helpText());
    return 0;
  }

  const config = configPath(values.config, ctx.env);
  switch (command) {
    case 'init': {
      const target = values.target;
      if (target !== undefined && target !== 'compose' && target !== 'kubernetes') {
        ctx.term.err('--target must be compose or kubernetes.');
        return 2;
      }
      return init(
        {
          configPath: config,
          target,
          namespace: values.namespace,
          nonInteractive: values['non-interactive'] ?? false,
          dryRun: values['dry-run'] ?? false,
        },
        ctx,
      );
    }
    case 'doctor':
      return doctor({ configPath: config, json: values.json ?? false }, ctx);
    case 'run':
    case 'chat':
    case 'ship':
      ctx.term.err(`'${command}' is not implemented yet. Run 'kodra-agent --help'.`);
      return 1;
    default:
      ctx.term.err(`Unknown command '${command}'. Run 'kodra-agent --help'.`);
      return 2;
  }
}
