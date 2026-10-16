import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfig } from '@kodra-agent/connectors';
import { describe, expect, it } from 'vitest';
import type { ApprovalOutcome, ApprovalRequest } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { Redactor } from '../redactor.ts';
import { configYaml, tempDir } from '../test-helpers.ts';
import { PolicyGate, policyDiffers } from './policy-gate.ts';

async function setup(mode: 'audited' | 'announced' | 'second-approver', answer: ApprovalOutcome) {
  const path = join(await tempDir(), 'audit.jsonl');
  const asked: ApprovalRequest[] = [];
  const announced: string[] = [];
  const gate = new PolicyGate({
    mode,
    approvals: {
      request: (req) => {
        asked.push(req);
        return Promise.resolve(answer);
      },
    },
    approvers: ['console:omar', 'console:sara'],
    expiresAfterMinutes: 15,
    audit: new AuditLog(path, new Redactor()),
    redactor: new Redactor(),
    announce: (text) => {
      announced.push(text);
      return Promise.resolve();
    },
  });
  const audit = async () =>
    (await readFile(path, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);
  return { gate, asked, announced, audit };
}

/** Holds a change and waits until the gate has finished with it. */
function holdAndWait(gate: PolicyGate, apply: () => Promise<string | null>) {
  let applied = false;
  return new Promise<{ applied: boolean; done: boolean }>((resolve) => {
    gate.hold(
      'console:omar',
      'changed gitlab.access',
      '-access: read-only\n+access: read-write-approved',
      async () => {
        applied = true;
        return apply();
      },
      () => {
        resolve({ applied, done: true });
      },
    );
    // Without approval, done is never called; give the background work time to finish.
    setTimeout(() => {
      resolve({ applied, done: false });
    }, 200);
  });
}

describe('PolicyGate', () => {
  it('in strict, waits for someone other than the person who saved, then applies', async () => {
    const { gate, asked, announced, audit } = await setup('second-approver', {
      decision: 'approved',
      by: 'console:sara',
    });
    const result = await holdAndWait(gate, () => Promise.resolve(null));
    expect(result).toEqual({ applied: true, done: true });
    const [req] = asked;
    expect(req?.ballot.requester).toBe('console:omar');
    expect(req?.ballot.cannotApprove('console:omar')).toBe(
      'You asked for this change, so someone else must approve it.',
    );
    expect(req?.preview).toContain('+access: read-write-approved');
    expect(announced).toEqual([
      'Policy change by console:omar: changed gitlab.access (approved by console:sara)\n```-access: read-only\n+access: read-write-approved```',
    ]);
    expect((await audit()).map((r) => `${r['event']}:${r['decision'] ?? ''}`)).toEqual([
      'approval.request:',
      'approval.decision:approved',
    ]);
    expect(gate.pending()).toEqual([]);
  });

  it('never applies a denied change', async () => {
    const { gate, announced } = await setup('second-approver', {
      decision: 'denied',
      by: 'console:sara',
    });
    expect(await holdAndWait(gate, () => Promise.resolve(null))).toEqual({
      applied: false,
      done: false,
    });
    expect(announced).toEqual([]);
  });

  it('records an approved change that could no longer apply', async () => {
    const { gate, announced, audit } = await setup('second-approver', {
      decision: 'approved',
      by: 'console:sara',
    });
    await holdAndWait(gate, () => Promise.resolve('the settings changed after it was asked'));
    expect(announced).toEqual([]);
    const last = (await audit()).at(-1);
    expect(last?.['event']).toBe('error');
    expect(last?.['detail']).toContain(
      'approved policy change not applied: the settings changed after it was asked',
    );
  });

  it('announces in team, and stays quiet in starter', async () => {
    const team = await setup('announced', { decision: 'expired' });
    await team.gate.announce('console:omar', 'added console:lead as an approver', '+ approver');
    expect(team.announced).toHaveLength(1);
    const starter = await setup('audited', { decision: 'expired' });
    await starter.gate.announce('console:omar', 'added console:lead as an approver', '+ approver');
    expect(starter.announced).toEqual([]);
  });
});

describe('policyDiffers', () => {
  const parse = (approvers: string, extra = '') => {
    const result = parseAgentConfig(
      configYaml({ auditPath: '/tmp/a.jsonl', approvers: [approvers] }) + extra,
    );
    if (!result.ok) throw new Error('bad config');
    return result.config;
  };

  it('sees approvers and limits differently', () => {
    expect(policyDiffers(parse('U01'), parse('U02'))).toBe(true);
    const budget = '  limits:\n    monthlyBudgetUsd: 25\n';
    expect(policyDiffers(parse('U01'), parse('U01', budget))).toBe(false);
  });
});
