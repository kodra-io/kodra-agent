import { verifyAuditChain } from '../audit.ts';
import { loadConfig } from '../config.ts';
import type { Context } from '../context.ts';

/**
 * `kodra-agent audit verify` (PLAN-v0.2 M14): checks the audit log's hash chain and says where
 * it first breaks. Editing, deleting, or reordering a record breaks it.
 */
export async function auditVerify(opts: { configPath: string; json: boolean }, ctx: Context) {
  const loaded = await loadConfig(opts.configPath);
  if (!loaded.ok) {
    for (const e of loaded.errors) ctx.term.err(e);
    return 1;
  }
  const path = loaded.config.spec.audit.path;
  const check = await verifyAuditChain(path);
  if (opts.json) {
    ctx.term.out(JSON.stringify({ path, ...check }, null, 2));
    return check.ok ? 0 : 1;
  }
  if (!check.ok) {
    ctx.term.err(`The audit log at ${path} is broken: ${check.problem ?? 'unknown problem'}.`);
    return 1;
  }
  if (!check.head) {
    ctx.term.out(`The audit log at ${path} has no chained records yet.`);
    return 0;
  }
  ctx.term.out(
    `The audit log at ${path} is intact: ${String(check.records)} chained records, the newest is ${String(check.head.seq)} (${check.head.hash.slice(0, 16)}).`,
  );
  if (check.unchained > 0) {
    ctx.term.out(
      `${String(check.unchained)} older records come from before the chain and are not covered.`,
    );
  }
  return 0;
}
