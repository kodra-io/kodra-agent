import { createHash } from 'node:crypto';
import { dynamicTool, jsonSchema, type Tool } from 'ai';
import type { ChangeStep } from '@kodra-agent/schema';
import { newApprovalRequest } from './approvals.ts';
import { unifiedDiff } from './diff.ts';
import type { FileReader } from './forge-files.ts';
import type { HostedTool } from './mcp/host.ts';
import { decide, type Risk } from './policy.ts';
import { wrapUntrusted, type AgentDeps } from './agent.ts';

/**
 * Proposed changes (M9): the model proposes several tool calls as one change, the agent
 * checks every step with the policy and builds a readable preview (a diff for file edits),
 * an approver approves the whole change once, and the agent runs exactly those steps in
 * order, with no model in the loop. Before each file write it reads the file again and
 * stops if it changed since the preview, so what runs is what was approved.
 */

export const PROPOSE_CHANGE = 'propose_change';
export const MAX_STEPS = 20;
/** A change too large to review in one approval is refused, not truncated. */
export const MAX_PREVIEW_CHARS = 40_000;
const MAX_DETAIL = 3_500;
const MAX_RESULT = 1_500;
const REASON_ARG = 'kodra_reason';

export interface ProposedStep {
  tool: HostedTool;
  args: Record<string, unknown>;
}

/** A file as it was when the preview was built, checked again right before it is written. */
interface Snapshot {
  step: number;
  repo: string;
  path: string;
  ref: string;
  hash: string | null;
  read: FileReader;
}

export interface Preview {
  text: string;
  snapshots: Snapshot[];
}

const RISK_ORDER: Record<string, number> = { read: 0, write: 1, destructive: 2, unclassified: 3 };

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${String(text.length - max)} more]`;
}

const hash = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function repoOf(spec: ChangeStep, args: Record<string, unknown>): string | undefined {
  const parts = spec.repo.map((key) => str(args[key]));
  return parts.every((p) => p !== undefined) ? parts.join('/') : undefined;
}

function defaultBranch(tool: HostedTool, repo: string): string | undefined {
  return tool.defaultBranches?.get(repo.toLowerCase()) ?? undefined;
}

/**
 * The preview an approver sees: one section per step, with a diff for each file edit. Reads
 * each file at the ref the write starts from: the branch's source when this change creates
 * the branch, otherwise the branch itself. Throws when a file cannot be read: a change that
 * cannot be shown is not proposed.
 */
export async function buildPreview(steps: readonly ProposedStep[]): Promise<Preview> {
  const sections: string[] = [];
  const snapshots: Snapshot[] = [];
  /** Branches this change creates: repo#branch -> the ref they start from. */
  const created = new Map<string, string>();
  /** Files this change already wrote: repo#branch#path -> content. */
  const written = new Map<string, string>();

  for (const [index, { tool, args }] of steps.entries()) {
    const n = index + 1;
    const spec = tool.changeStep;
    const repo = spec ? repoOf(spec, args) : undefined;
    const label = `${String(n)}. ${tool.connector}/${tool.tool}`;

    if (!spec || !repo) {
      sections.push(`${label}\n${clip(JSON.stringify(args, null, 2), 4_000)}`);
      continue;
    }
    const key = (branch: string) => `${repo.toLowerCase()}#${branch}`;

    if (spec.kind === 'branch') {
      const branch = str(args[spec.branch]) ?? '?';
      const from = str(args[spec.from]) ?? defaultBranch(tool, repo);
      if (from) created.set(key(branch), from);
      sections.push(
        `${label}: create branch ${branch} in ${repo}, from ${from ?? 'the default branch'}`,
      );
      continue;
    }

    if (spec.kind === 'pull-request') {
      sections.push(
        `${label}: open a pull request in ${repo}, ${str(args[spec.head]) ?? '?'} into ${str(args[spec.base]) ?? '?'}: "${str(args[spec.title]) ?? ''}"`,
      );
      continue;
    }

    const branch = str(args[spec.branch]);
    if (!branch) throw new Error(`step ${String(n)} has no branch`);
    const items: Record<string, unknown>[] =
      spec.kind === 'file'
        ? [{ path: args[spec.path], content: args[spec.content] }]
        : (Array.isArray(args[spec.files]) ? (args[spec.files] as unknown[]) : []).map((f) => {
            const item = (f ?? {}) as Record<string, unknown>;
            return { path: item[spec.path], content: item[spec.content] };
          });
    const files = items.map((f) => ({ path: str(f['path']), content: f['content'] }));
    if (files.length === 0 || files.some((f) => f.path === undefined)) {
      throw new Error(`step ${String(n)} names no file`);
    }
    if (files.some((f) => typeof f.content !== 'string')) {
      throw new Error(`step ${String(n)}: file content must be text`);
    }
    const ref = created.get(key(branch)) ?? branch;
    for (const file of files as { path: string; content: string }[]) {
      const fileKey = `${key(branch)}#${file.path}`;
      let before: string | null;
      const pending = written.get(fileKey);
      if (pending !== undefined) {
        before = pending;
      } else {
        if (!tool.readFile) {
          throw new Error(`cannot read ${file.path} to show the change (no access to ${repo})`);
        }
        before = await tool.readFile(repo, file.path, ref);
        snapshots.push({
          step: index,
          repo,
          path: file.path,
          ref,
          hash: hash(before),
          read: tool.readFile,
        });
      }
      written.set(fileKey, file.content);
      const diff = unifiedDiff(before ?? '', file.content);
      sections.push(
        [
          `${label}: ${before === null ? 'add' : 'change'} ${file.path} in ${repo} on ${branch}`,
          `--- ${before === null ? '/dev/null' : `a/${file.path} (${ref})`}`,
          `+++ b/${file.path} (${branch})`,
          diff === '' ? '(no change)' : diff,
        ].join('\n'),
      );
    }
  }
  const text = sections.join('\n\n');
  if (text.length > MAX_PREVIEW_CHARS) {
    throw new Error(
      `the change is too large to review in one approval (${String(text.length)} characters); split it into smaller changes`,
    );
  }
  return { text, snapshots };
}

/** The `propose_change` tool: offered with the other tools whenever a write is possible. */
export function proposeChangeTool(
  deps: AgentDeps,
  task: string,
  offered: readonly HostedTool[],
): Tool {
  const actor = deps.actor ?? 'agent';
  const byName = new Map(offered.map((t) => [t.name, t]));
  const r = (s: string) => deps.redactor.redact(s);

  return dynamicTool({
    description: [
      'Propose a change made of several tool calls (for example: create a branch, edit files, open a pull request).',
      'The approver sees one preview, with a diff for each file, and approves the whole change once.',
      'Then the steps run in order, exactly as proposed. Read each file first and send its full new content.',
    ].join(' '),
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line: what the change does.' },
        reason: { type: 'string', description: 'Why it is needed, shown to the approver.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'A tool name you were given.' },
              args: { type: 'object', description: "That tool's arguments." },
            },
            required: ['tool', 'args'],
          },
        },
      },
      required: ['title', 'reason', 'steps'],
    }),
    execute: async (input, options) => {
      const raw = (input ?? {}) as Record<string, unknown>;
      const title = clip(r(str(raw['title']) ?? 'Change'), 120);
      const reason = clip(r(str(raw['reason']) ?? '(no reason given)'), 1_000);
      const rawSteps = Array.isArray(raw['steps']) ? (raw['steps'] as unknown[]) : [];
      const call = options.toolCallId;
      const reply = (text: string) => wrapUntrusted(PROPOSE_CHANGE, text, deps.redactor);
      const refuse = (message: string) =>
        reply(`NOT PROPOSED: ${message}. Nothing was run. Fix the proposal and try again.`);

      if (rawSteps.length === 0 || rawSteps.length > MAX_STEPS) {
        return refuse(`a change has 1 to ${String(MAX_STEPS)} steps`);
      }
      const steps: ProposedStep[] = [];
      for (const [index, item] of rawSteps.entries()) {
        const step = (item ?? {}) as Record<string, unknown>;
        const tool = byName.get(String(step['tool']));
        if (!tool) return refuse(`step ${String(index + 1)} names a tool you were not given`);
        const args = Object.fromEntries(
          Object.entries(
            (step['args'] && typeof step['args'] === 'object' ? step['args'] : {}) as Record<
              string,
              unknown
            >,
          ).filter(([key]) => key !== REASON_ARG),
        );
        steps.push({ tool, args });
      }

      const pausedReason = deps.paused?.() ?? null;
      if (pausedReason) return refuse(pausedReason);

      // Every step must pass the policy before anyone is asked.
      for (const [index, { tool, args }] of steps.entries()) {
        const decision = decide({
          risk: tool.risk,
          access: tool.access,
          destructiveActions: deps.policy.destructiveActions,
          guards: tool.guards,
          args,
          settings: tool.settings,
          ...(tool.defaultBranches ? { defaultBranches: tool.defaultBranches } : {}),
          ...(tool.sharedSettings ? { sharedSettings: tool.sharedSettings } : {}),
        });
        if (decision.kind === 'block') {
          await deps.audit.append({
            actor,
            task,
            event: 'tool.call',
            connector: tool.connector,
            tool: tool.tool,
            risk: tool.risk,
            decision: 'blocked',
            detail: clip(
              `proposed change, step ${String(index + 1)}: ${decision.reason}`,
              MAX_DETAIL,
            ),
          });
          return refuse(
            `step ${String(index + 1)} (${tool.connector}/${tool.tool}) is blocked by policy: ${decision.reason}`,
          );
        }
      }

      let preview: Preview;
      try {
        preview = await buildPreview(steps);
      } catch (error) {
        return refuse(r(error instanceof Error ? error.message : String(error)));
      }

      const risk = steps
        .map((s) => s.tool.risk)
        .reduce<Risk>((a, b) => ((RISK_ORDER[b] ?? 0) > (RISK_ORDER[a] ?? 0) ? b : a), 'read');
      const connectors = [...new Set(steps.map((s) => s.tool.connector))].join(', ');
      const names = steps.map((s) => `${s.tool.connector}/${s.tool.tool}`).join(', ');
      const req = newApprovalRequest(
        {
          connector: connectors,
          tool: PROPOSE_CHANGE,
          risk,
          args: clip(r(names), 2_000),
          reason,
          requestedBy: actor,
          title,
          preview: r(preview.text),
        },
        deps.policy.expiresAfterMinutes,
      );
      await deps.audit.append({
        actor,
        task,
        event: 'approval.request',
        connector: connectors,
        tool: PROPOSE_CHANGE,
        risk: risk === 'unclassified' ? 'unclassified' : risk,
        detail: clip(`${req.id}; change: ${title}; steps: ${names}`, MAX_DETAIL),
      });
      deps.events?.({
        type: 'approval',
        call,
        id: req.id,
        connector: req.connector,
        tool: req.tool,
        risk: req.risk,
        args: req.args,
        reason: req.reason,
        expiresAt: req.expiresAt.toISOString(),
        title,
        ...(req.preview ? { preview: req.preview } : {}),
      });
      const outcome = await deps.approvals.request(req);
      const note =
        outcome.decision === 'denied' && outcome.note ? clip(r(outcome.note), 500) : undefined;
      await deps.audit.append({
        actor: outcome.decision === 'expired' ? actor : outcome.by,
        task,
        event: 'approval.decision',
        connector: connectors,
        tool: PROPOSE_CHANGE,
        decision: outcome.decision,
        detail: note ? `${req.id}; ${note}` : req.id,
      });
      deps.events?.({
        type: 'decision',
        call,
        id: req.id,
        decision: outcome.decision,
        ...(outcome.decision === 'expired' ? {} : { by: outcome.by }),
      });
      if (outcome.decision !== 'approved') {
        deps.term.out(`  [${outcome.decision}] change: ${title}`);
        return reply(
          outcome.decision === 'expired'
            ? 'The approver did not answer in time. Nothing was run.'
            : `The approver denied this change${note ? `, saying: ${note}` : ''}. Nothing was run.`,
        );
      }

      // Run exactly the approved steps, in order. Stop at the first problem.
      const results: string[] = [];
      for (const [index, { tool, args }] of steps.entries()) {
        const n = `${String(index + 1)}/${String(steps.length)}`;
        const stepCall = `${call}#${String(index + 1)}`;
        const argText = r(JSON.stringify(args));
        const event = (state: 'running' | 'ok' | 'error', detail?: string) => {
          deps.events?.({
            type: 'tool',
            call: stepCall,
            connector: tool.connector,
            tool: tool.tool,
            risk: tool.risk,
            args: clip(argText, 2_000),
            state,
            ...(detail === undefined ? {} : { detail: r(detail) }),
          });
        };
        const stop = async (why: string) => {
          event('error', why);
          await deps.audit.append({
            actor,
            task,
            event: 'error',
            connector: tool.connector,
            tool: tool.tool,
            detail: clip(r(`change ${req.id} step ${n}: ${why}`), MAX_DETAIL),
          });
          results.push(`Step ${n} ${tool.connector}/${tool.tool}: STOPPED: ${why}`);
          return reply(
            `Change "${title}" stopped at step ${n}. Steps after it did not run.\n${results.join('\n')}`,
          );
        };

        const pausedNow = deps.paused?.() ?? null;
        if (pausedNow) return await stop(pausedNow);
        for (const snap of preview.snapshots.filter((s) => s.step === index)) {
          let now: string | null;
          try {
            now = await snap.read(snap.repo, snap.path, snap.ref);
          } catch (error) {
            return await stop(
              `could not read ${snap.path} again: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (hash(now) !== snap.hash) {
            return await stop(
              `${snap.path} changed on ${snap.ref} after the preview, so it was not written`,
            );
          }
        }

        event('running');
        deps.term.out(`  [${tool.risk}] ${tool.connector}/${tool.tool} (change ${n})`);
        let ok: boolean;
        let text: string;
        try {
          const result = await deps.host.call(tool.name, args, options.abortSignal);
          ok = !result.isError;
          text = result.text;
        } catch (error) {
          ok = false;
          text = error instanceof Error ? error.message : String(error);
        }
        await deps.audit.append({
          actor,
          task,
          event: 'tool.call',
          connector: tool.connector,
          tool: tool.tool,
          risk: tool.risk,
          decision: 'approved',
          detail: clip(
            `change ${req.id} step ${n}; ${ok ? 'ok' : 'error'}; args ${argText}`,
            MAX_DETAIL,
          ),
        });
        if (!ok) return await stop(`the tool failed: ${clip(r(text), MAX_RESULT)}`);
        event('ok');
        results.push(`Step ${n} ${tool.connector}/${tool.tool}: ${clip(r(text), MAX_RESULT)}`);
      }
      return reply(
        `Change "${title}" ran, all ${String(steps.length)} steps.\n${results.join('\n')}`,
      );
    },
  });
}
