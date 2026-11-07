import { recordOverride } from '../agent.ts';
import {
  cliApprovalChannel,
  decisionAudit,
  newApprovalRequest,
  type ApprovalChannel,
  type ApprovalOutcome,
  type RequestRules,
} from '../approvals.ts';
import type { Context } from '../context.ts';
import type { Risk } from '../policy.ts';
import type { Runtime } from '../runtime.ts';

/** Without a terminal there is nobody to approve, so the change is refused. */
export const refuseAll: ApprovalChannel = {
  request: () => Promise.resolve({ decision: 'denied', by: 'no-terminal' }),
};

export interface ApproveInput {
  ctx: Context;
  runtime: Runtime;
  /** The console's or Slack's approvals; else the terminal, else nobody. */
  approvals?: ApprovalChannel | undefined;
  requestedBy?: string | undefined;
  task: string;
  connector: string;
  tool: string;
  risk: Risk;
  /** The arguments, already redacted, for the request and the audit log. */
  args: string;
  reason: string;
  rules: RequestRules;
}

/** Asks for one approval for ship, audited with its decision and any freeze override. */
export async function approveShipChange(i: ApproveInput): Promise<ApprovalOutcome> {
  const { ctx, runtime } = i;
  const req = newApprovalRequest(
    {
      connector: i.connector,
      tool: i.tool,
      risk: i.risk,
      args: i.args,
      reason: i.reason,
      requestedBy: i.requestedBy ?? 'ship',
    },
    i.rules,
  );
  const base = { actor: 'ship', task: i.task, connector: i.connector, risk: i.risk } as const;
  await runtime.audit.append({
    ...base,
    event: 'approval.request',
    tool: req.tool,
    detail: `${req.id}; args ${i.args}`,
  });
  const channel =
    i.approvals ?? (ctx.prompter ? cliApprovalChannel(ctx.prompter, ctx.term) : refuseAll);
  const outcome = await channel.request(req);
  await runtime.audit.append({
    ...base,
    event: 'approval.decision',
    tool: req.tool,
    ...decisionAudit(req, outcome, 'ship', undefined),
  });
  await recordOverride({ audit: runtime.audit, redactor: ctx.redactor }, req, outcome, {
    actor: 'ship',
    task: i.task,
    connector: i.connector,
    tool: req.tool,
  });
  return outcome;
}
