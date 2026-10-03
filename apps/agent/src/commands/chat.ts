import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { runTurn, type AgentDeps } from '../agent.ts';
import { cliApprovalChannel, type ApprovalChannel } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { components, loadConfig, secretLabel } from '../config.ts';
import type { Context } from '../context.ts';
import { parseEnvFile } from '../env-file.ts';
import { createModel } from '../llm.ts';
import { ConnectorHost, type ConnectorInput } from '../mcp/host.ts';
import { resolveAll } from '../secrets.ts';

export interface ChatOptions {
  configPath: string;
  /** Send one message, print the answer, and exit (for scripts and tests). */
  message?: string | undefined;
}

/** Without a terminal there is nobody to approve, so every approval is refused. */
const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'no-terminal' }),
};

export async function chat(opts: ChatOptions, ctx: Context): Promise<number> {
  const loaded = await loadConfig(opts.configPath);
  if (!loaded.ok) {
    for (const e of loaded.errors) ctx.term.err(e);
    return 1;
  }
  const { config, dir } = loaded;
  if (opts.message === undefined && !ctx.prompter) {
    ctx.term.err('No terminal to chat on. Use --message "<question>" to ask one thing.');
    return 1;
  }

  // Like doctor: inside the container compose already loads .env; outside it, read it too.
  const dotenvText = await readFile(join(dir, '.env'), 'utf8').catch(() => '');
  const env = { ...Object.fromEntries(parseEnvFile(dotenvText)), ...ctx.env };

  const comps = components(config);
  const inputs: ConnectorInput[] = [];
  let modelSecrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const comp of comps) {
    const resolved = await resolveAll(comp.secrets, { env, redactor: ctx.redactor });
    for (const gap of resolved.missing) {
      if (gap.use.spec.required) missing.push(`${secretLabel(gap.use)}: ${gap.reason}`);
    }
    if (comp.manifest.category === 'model') {
      modelSecrets = resolved.values;
      continue;
    }
    const entry = config.spec.connectors[comp.id];
    const access = comp.manifest.accessLevels.length > 0 ? entry?.access : undefined;
    inputs.push({ component: comp, access, secrets: resolved.values });
  }
  if (missing.length > 0) {
    for (const m of missing) ctx.term.err(`Missing ${m}`);
    ctx.term.err('Run `kodra-agent init`, then `kodra-agent doctor`.');
    return 1;
  }

  const audit = new AuditLog(config.spec.audit.path, ctx.redactor);
  let host: ConnectorHost;
  try {
    host = await ConnectorHost.start(inputs, {
      redactor: ctx.redactor,
      log: ctx.log,
      audit,
      env,
      ...(ctx.launcher ? { launcher: ctx.launcher } : {}),
    });
  } catch (error) {
    ctx.term.err(error instanceof Error ? error.message : 'Could not start the connectors.');
    ctx.term.err('If a server binary is missing, run: pnpm mcp:fetch');
    return 1;
  }

  try {
    const model = (ctx.modelFactory ?? createModel)(config.spec.model, modelSecrets);
    const deps: AgentDeps = {
      model,
      modelLabel: `${config.spec.model.provider}/${config.spec.model.name}`,
      host,
      approvals: ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll,
      audit,
      redactor: ctx.redactor,
      term: ctx.term,
      policy: {
        destructiveActions: config.spec.policy.destructiveActions,
        expiresAfterMinutes: config.spec.policy.approvals.expiresAfterMinutes,
      },
      ...(ctx.limits ? { limits: ctx.limits } : {}),
      actor: 'agent',
    };

    const counts = new Map<string, number>();
    for (const tool of host.tools())
      counts.set(tool.connector, (counts.get(tool.connector) ?? 0) + 1);
    ctx.term.out(`Kodra AI Agent, model ${deps.modelLabel}.`);
    for (const input of inputs) {
      const n = counts.get(input.component.id) ?? 0;
      ctx.term.out(
        `  ${input.component.displayName}: ${input.access ?? 'on'}, ${String(n)} tool${n === 1 ? '' : 's'}`,
      );
    }

    let history: ModelMessage[] = [];
    const turn = async (text: string) => {
      const result = await runTurn(deps, history, text, `chat-${randomUUID().slice(0, 8)}`);
      history = result.messages;
      ctx.term.out('');
      ctx.term.out(result.text);
    };

    if (opts.message !== undefined) {
      await turn(opts.message);
      return 0;
    }
    const prompter = ctx.prompter;
    if (!prompter) return 1;
    ctx.term.out('Ask a question. Type /exit to leave.');
    for (;;) {
      let line: string;
      try {
        line = (await prompter.text('you>')).trim();
      } catch {
        break;
      }
      if (line === '/exit' || line === '/quit') break;
      if (line === '') continue;
      try {
        await turn(line);
      } catch (error) {
        ctx.term.err(`Error: ${error instanceof Error ? error.message : 'the request failed'}`);
      }
    }
    return 0;
  } finally {
    await host.close();
  }
}
