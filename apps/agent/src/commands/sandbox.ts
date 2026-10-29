import type { Context } from '../context.ts';
import { startRuntime } from '../runtime.ts';
import {
  parseKeep,
  sandboxDeploy,
  sandboxDestroy,
  sandboxList,
  sandboxSweep,
} from '../sandbox/sandbox.ts';

export interface SandboxCommand {
  configPath: string;
  /** deploy, list, destroy, or sweep. */
  action: string | undefined;
  /** The repo for deploy, the test id for destroy. */
  arg: string | undefined;
  branch?: string | undefined;
  tag?: string | undefined;
  keep?: string | undefined;
  json: boolean;
}

const USAGE = [
  'Usage:',
  '  kodra-agent sandbox deploy <repo> [--branch <name>] [--tag <tag>] [--keep <30m|2h>]',
  '  kodra-agent sandbox list [--json]',
  '  kodra-agent sandbox destroy <id>',
  '  kodra-agent sandbox sweep',
].join('\n');

/** `kodra-agent sandbox`: test a branch in the sandbox namespace, then destroy it (B2). */
export async function sandbox(opts: SandboxCommand, ctx: Context): Promise<number> {
  if (opts.action === 'deploy') {
    if (!opts.arg) {
      ctx.term.err(USAGE);
      return 2;
    }
    const keepMs = opts.keep === undefined ? 0 : parseKeep(opts.keep);
    if (keepMs === null) {
      ctx.term.err('--keep takes minutes or hours, like 30m or 2h, up to 24h.');
      return 2;
    }
    return sandboxDeploy(
      { configPath: opts.configPath, repo: opts.arg, branch: opts.branch, tag: opts.tag, keepMs },
      ctx,
    );
  }
  if (!['list', 'destroy', 'sweep'].includes(opts.action ?? '')) {
    ctx.term.err(USAGE);
    return 2;
  }
  if (opts.action === 'destroy' && !opts.arg) {
    ctx.term.err(USAGE);
    return 2;
  }
  const runtime = await startRuntime(opts.configPath, ctx);
  if (!runtime) return 1;
  try {
    if (opts.action === 'list') {
      const tests = await sandboxList(runtime);
      if (opts.json) ctx.term.out(JSON.stringify(tests, null, 2));
      else if (tests.length === 0) ctx.term.out('No sandbox tests are up.');
      else {
        for (const t of tests) {
          ctx.term.out(
            `${t.id}  ${t.release}  ${t.repo} (${t.branch} @ ${t.sha.slice(0, 7)})  ${t.result ?? 'running'}  until ${t.expiresAt.slice(0, 16).replace('T', ' ')} UTC`,
          );
        }
      }
      return 0;
    }
    if (opts.action === 'destroy') {
      const done = await sandboxDestroy(ctx, runtime, opts.arg ?? '', 'cli');
      if (!done.ok) {
        ctx.term.err(done.reason);
        return 1;
      }
      ctx.term.out(`Destroyed ${opts.arg ?? ''}.`);
      return 0;
    }
    const swept = await sandboxSweep(ctx, runtime);
    for (const p of swept.problems) ctx.term.err(p);
    ctx.term.out(
      swept.destroyed.length > 0 ? `Destroyed ${swept.destroyed.join(', ')}.` : 'Nothing to sweep.',
    );
    return swept.problems.length > 0 ? 1 : 0;
  } finally {
    await runtime.close();
  }
}
