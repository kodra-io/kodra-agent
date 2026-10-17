import type { AgentConfig, PolicyChanges } from '@kodra-agent/schema';
import {
  decisionAudit,
  newApprovalRequest,
  type ApprovalChannel,
  type ApprovalRequest,
} from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { Redactor } from '../redactor.ts';

/** Where a model sends data: the provider and its address. */
export function modelDestination(c: AgentConfig): string {
  const m = c.spec.model as Record<string, unknown>;
  const where = ['baseUrl', 'endpoint', 'region']
    .map((k) => m[k])
    .find((v) => typeof v === 'string');
  return typeof where === 'string' ? `${c.spec.model.provider} (${where})` : c.spec.model.provider;
}

/**
 * The parts of a config that decide who may change what (PLAN-v0.2 M11): the profile,
 * environments, approvers and approval rules, destructive actions, and each connector's
 * access and scope, and where the model sends data. A console save that changes any of them
 * is a policy change.
 */
export function policyDiffers(before: AgentConfig, after: AgentConfig): boolean {
  const part = (c: AgentConfig) =>
    JSON.stringify({
      profile: c.spec.profile,
      environments: c.spec.environments,
      policy: c.spec.policy,
      // Where questions and tool output go (a provider switch).
      model: modelDestination(c),
      connectors: Object.fromEntries(
        Object.entries(c.spec.connectors)
          .filter(([, e]) => e?.enabled)
          .map(([id, e]) => [id, { access: e?.access ?? null, config: e?.config ?? {} }]),
      ),
    });
  return part(before) !== part(after);
}

export interface PendingPolicyChange {
  id: string;
  title: string;
  requestedBy: string;
  expiresAt: string;
}

export interface PolicyGateDeps {
  mode: PolicyChanges;
  /** Slack and the console, like any other approval. */
  approvals: ApprovalChannel;
  /** Every approver in the config; the person who saves cannot approve their own change. */
  approvers: readonly string[];
  expiresAfterMinutes: number;
  audit: AuditLog;
  redactor: Redactor;
  announce?: ((text: string) => Promise<void>) | undefined;
}

/**
 * Policy changes made in the console: audited always, also announced to all approvers with
 * the diff (team), or held until a second approver agrees (strict). A held change runs its
 * `apply` only after approval, and is checked again then (the settings may have moved on).
 */
export class PolicyGate {
  private readonly deps: PolicyGateDeps;
  private readonly waiting = new Map<string, { req: ApprovalRequest; title: string }>();

  constructor(deps: PolicyGateDeps) {
    this.deps = deps;
  }

  get mode(): PolicyChanges {
    return this.deps.mode;
  }

  pending(): PendingPolicyChange[] {
    return [...this.waiting.values()].map(({ req, title }) => ({
      id: req.id,
      title,
      requestedBy: req.requestedBy,
      expiresAt: req.expiresAt.toISOString(),
    }));
  }

  /** Tells every approver about a change that was just applied (team and strict). */
  async announce(by: string, title: string, diff: string): Promise<void> {
    if (this.deps.mode === 'audited') return;
    const shown = diff.length > 2_500 ? `${diff.slice(0, 2_500)}\n…` : diff;
    await this.deps
      .announce?.(
        this.deps.redactor.redact(`Policy change by ${by}: ${title}\n\`\`\`${shown}\`\`\``),
      )
      .catch(() => undefined);
  }

  /**
   * Holds a change for a second approver (strict). Returns at once; `apply` runs after the
   * approval, and its result is audited and announced.
   */
  hold(
    by: string,
    title: string,
    diff: string,
    apply: () => Promise<string | null>,
    done: () => void,
  ): string {
    const req = newApprovalRequest(
      {
        connector: 'kodra-agent',
        tool: 'settings',
        risk: 'write',
        args: this.deps.redactor.redact(title),
        reason: 'A policy change from the console needs a second approver.',
        requestedBy: by,
        title: this.deps.redactor.redact(`Policy change: ${title}`),
        preview: this.deps.redactor.redact(diff),
      },
      {
        environment: null,
        approvers: [...this.deps.approvers],
        minApprovers: 1,
        allowSelfApproval: false,
        expiresAfterMinutes: this.deps.expiresAfterMinutes,
        requireChangeRef: false,
        changeRefPattern: null,
        freeze: null,
      },
    );
    this.waiting.set(req.id, { req, title });
    const base = { actor: by, connector: 'kodra-agent', tool: 'settings', risk: 'write' as const };
    void (async () => {
      await this.deps.audit.append({
        ...base,
        event: 'approval.request',
        detail: `${req.id}; change: ${title}; steps: policy change`.slice(0, 3_500),
      });
      const outcome = await this.deps.approvals
        .request(req)
        .catch((): { decision: 'expired' } => ({ decision: 'expired' }));
      this.waiting.delete(req.id);
      await this.deps.audit.append({
        ...base,
        event: 'approval.decision',
        ...decisionAudit(req, outcome, by, undefined),
      });
      if (outcome.decision !== 'approved') return;
      const problem = await apply().catch((e: unknown) =>
        e instanceof Error ? e.message : String(e),
      );
      if (problem) {
        await this.deps.audit.append({
          ...base,
          event: 'error',
          detail: `${req.id}; approved policy change not applied: ${problem}`.slice(0, 3_500),
        });
        return;
      }
      await this.announce(by, `${title} (approved by ${outcome.by})`, diff);
      done();
    })();
    return req.id;
  }
}
