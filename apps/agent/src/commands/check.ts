import { checkRunner } from '../checks/setup.ts';
import { digestText } from '../checks/digest.ts';
import type { Context } from '../context.ts';
import { proxyOptions } from '../network.ts';
import { startRuntime } from '../runtime.ts';
import { boltSlack } from '../slack/api.ts';

export interface CheckOptions {
  configPath: string;
  /** Post the digest to the Slack channel and save it as the latest; otherwise only print it. */
  post: boolean;
  json: boolean;
}

/**
 * Runs the read-only checks once and prints the digest (M27). Without --post nothing is
 * saved, so the next scheduled digest still calls today's problems new. Exit code 1 when
 * something is broken, so it can gate a script.
 */
export async function check(opts: CheckOptions, ctx: Context): Promise<number> {
  const runtime = await startRuntime(opts.configPath, ctx, { connectorLogFile: true });
  if (!runtime) return 1;
  try {
    const slackInput = runtime.inputs.find((i) => i.component.id === 'slack');
    const botToken = slackInput?.secrets['botToken'];
    const appToken = slackInput?.secrets['appToken'];
    if (opts.post && (!slackInput || !botToken || !appToken)) {
      ctx.term.err('--post needs the Slack connector with its bot and app tokens.');
      return 2;
    }
    const post = async (text: string) => {
      if (!slackInput || !botToken || !appToken) return;
      const slack = (ctx.slackConnection ?? boltSlack)(
        botToken,
        appToken,
        proxyOptions(runtime.network),
      );
      await slack.api.postMessage({
        channel: String(slackInput.component.settings['channel']),
        text,
      });
    };
    const runner = await checkRunner(runtime, ctx, {
      post,
      ...(ctx.checksNow ? { now: ctx.checksNow } : {}),
    });
    const digest = await runner.run('run from the command line', {
      post: opts.post,
      commit: opts.post,
    });
    if (opts.json) ctx.term.out(JSON.stringify(digest, null, 2));
    else ctx.term.out(digestText(digest));
    if (opts.post) ctx.term.out('Posted to Slack.');
    return digest.fresh.length + digest.ongoing.length > 0 ? 1 : 0;
  } finally {
    await runtime.close();
  }
}
