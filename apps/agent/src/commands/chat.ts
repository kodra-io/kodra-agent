import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { runTurn } from '../agent.ts';
import { cliApprovalChannel, type ApprovalChannel } from '../approvals.ts';
import type { Context } from '../context.ts';
import { describeConnectors, startRuntime } from '../runtime.ts';

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
  if (opts.message === undefined && !ctx.prompter) {
    ctx.term.err('No terminal to chat on. Use --message "<question>" to ask one thing.');
    return 1;
  }
  const runtime = await startRuntime(opts.configPath, ctx, { connectorLogFile: true });
  if (!runtime) return 1;

  try {
    const deps = runtime.deps(
      ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll,
    );
    ctx.term.out(`Kodra AI Agent, model ${deps.modelLabel}.`);
    for (const line of describeConnectors(runtime)) ctx.term.out(`  ${line}`);
    if (runtime.connectorLogPath) ctx.term.out(`Connector logs: ${runtime.connectorLogPath}`);

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
    await runtime.close();
  }
}
