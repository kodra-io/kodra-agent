import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { REASON_ARG, type AgentDeps } from '../agent.ts';
import type { ApprovalChannel } from '../approvals.ts';
import { AuditLog } from '../audit.ts';
import { jsonLogger, memoryTerminal } from '../io.ts';
import { ConnectorHost } from '../mcp/host.ts';
import { Redactor } from '../redactor.ts';
import { fakeComponent, fakeLauncher } from '../test-fixtures/fake-connector.ts';
import { tempDir } from '../test-helpers.ts';
import { ConsoleApprovals } from './approvals.ts';
import { ConsoleChat, type ChatEvent } from './chat.ts';

type LanguageModelV4GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const SECRET = 'sk-console-chat-secret-9f8e7d6c'; // gitleaks:allow
const viewer = { name: 'console', canApprove: false };
const approver = { name: 'console:omar', canApprove: true };

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const answer = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage,
  warnings: [],
});
const call = (toolName: string, input: Record<string, unknown>): LanguageModelV4GenerateResult => ({
  content: [
    { type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage,
  warnings: [],
});

let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function setup(opts: {
  doGenerate: MockLanguageModelV4['doGenerate'] | LanguageModelV4GenerateResult[];
  maxConcurrent?: number;
  maxMessagesPerMinute?: number;
}) {
  const redactor = new Redactor();
  redactor.add(SECRET);
  host = await ConnectorHost.start(
    [{ component: fakeComponent(), access: 'read-write-approved', secrets: {} }],
    { redactor, log: jsonLogger(() => undefined, redactor), launcher: fakeLauncher(), env: {} },
  );
  const audit = new AuditLog(join(await tempDir(), 'audit.jsonl'), redactor);
  const model = new MockLanguageModelV4({ doGenerate: opts.doGenerate });
  const pending = new ConsoleApprovals({ audit });
  const started = host;
  const deps = (approvals: ApprovalChannel): AgentDeps => ({
    model,
    modelLabel: 'mock/model',
    host: started,
    approvals,
    audit,
    redactor,
    term: memoryTerminal(redactor),
    policy: { destructiveActions: 'deny', expiresAfterMinutes: 15 },
  });
  const chat = new ConsoleChat({
    deps,
    approvals: pending.channel,
    redactor,
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.maxMessagesPerMinute ? { maxMessagesPerMinute: opts.maxMessagesPerMinute } : {}),
  });
  return { chat, model, pending };
}

/** Collects a conversation's events until a predicate holds. */
function collect(chat: ConsoleChat, id: string, until: (e: ChatEvent) => boolean) {
  const events: ChatEvent[] = [];
  return new Promise<ChatEvent[]>((resolve) => {
    const stop = chat.subscribe(id, 0, (e) => {
      events.push(e);
      if (until(e)) {
        queueMicrotask(() => stop?.());
        resolve(events);
      }
    });
  });
}

const idle = (e: ChatEvent) => e.type === 'status' && e.state === 'idle';

describe('ConsoleChat', () => {
  it('answers, streams each step, and keeps the history for the next message', async () => {
    const { chat, model } = await setup({ doGenerate: [answer('First.'), answer('Second.')] });
    const sent = chat.send(viewer, undefined, 'why is web failing?');
    if (!sent.ok) throw new Error(sent.error);
    const events = await collect(chat, sent.conversation, idle);
    expect(events.map((e) => e.type)).toEqual(['user', 'status', 'answer', 'status']);
    expect(events[2]).toMatchObject({ type: 'answer', text: 'First.' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(chat.list()).toEqual([
      expect.objectContaining({ title: 'why is web failing?', startedBy: 'console', busy: false }),
    ]);

    expect(chat.send(viewer, sent.conversation, 'and now?').ok).toBe(true);
    await chat.idle();
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('why is web failing?');
    // A late subscriber replays only what it has not seen.
    const replay: ChatEvent[] = [];
    chat.subscribe(sent.conversation, 6, (e) => replay.push(e))?.();
    expect(replay.map((e) => e.seq)).toEqual([7, 8]);
  });

  it('refuses empty, oversized, unknown, busy, and too many messages', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { chat } = await setup({
      doGenerate: async () => {
        await gate;
        return answer('ok');
      },
      maxMessagesPerMinute: 2,
    });
    expect(chat.send(viewer, undefined, '   ')).toMatchObject({ ok: false, status: 400 });
    expect(chat.send(viewer, undefined, 'x'.repeat(8_001))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(chat.send(viewer, 'nope', 'hi')).toMatchObject({ ok: false, status: 404 });
    const first = chat.send(viewer, undefined, 'one');
    if (!first.ok) throw new Error(first.error);
    expect(chat.send(viewer, first.conversation, 'two')).toMatchObject({ ok: false, status: 409 });
    expect(chat.send(viewer, undefined, 'three').ok).toBe(true);
    expect(chat.send(viewer, undefined, 'four')).toMatchObject({ ok: false, status: 429 });
    expect(chat.send(approver, undefined, 'five').ok).toBe(true);
    release();
    await chat.idle();
  });

  it('runs at most maxConcurrent turns at once and queues the rest', async () => {
    let active = 0;
    let peak = 0;
    const { chat } = await setup({
      doGenerate: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return answer('ok');
      },
      maxConcurrent: 1,
    });
    const a = chat.send(viewer, undefined, 'a');
    const b = chat.send(viewer, undefined, 'b');
    const c = chat.send(viewer, undefined, 'c');
    if (!a.ok || !b.ok || !c.ok) throw new Error('send failed');
    const events = await collect(chat, c.conversation, idle);
    expect(events.map((e) => (e.type === 'status' ? e.state : e.type))).toEqual([
      'user',
      'queued',
      'working',
      'answer',
      'idle',
    ]);
    await chat.idle();
    expect(peak).toBe(1);
  });

  it('asks for approval in the console, and runs the tool once approved', async () => {
    const { chat, pending } = await setup({
      doGenerate: [
        call('fakek8s__resources_scale', {
          namespace: 'api',
          name: 'web',
          scale: 3,
          [REASON_ARG]: 'spike',
        }),
        answer('Scaled.'),
      ],
    });
    const sent = chat.send(viewer, undefined, 'scale web');
    if (!sent.ok) throw new Error(sent.error);
    const asked = await collect(chat, sent.conversation, (e) => e.type === 'approval');
    const request = asked.at(-1);
    expect(request).toMatchObject({ type: 'approval', tool: 'resources_scale', reason: 'spike' });
    expect(pending.list()).toHaveLength(1);
    // The viewer who asked cannot approve; an approver can.
    expect(await pending.decide(viewer, pending.list()[0]?.id ?? '', true)).toBe('refused');
    expect(await pending.decide(approver, pending.list()[0]?.id ?? '', true)).toBe('approved');
    const events = await collect(chat, sent.conversation, idle);
    expect(events.map((e) => (e.type === 'tool' ? `tool:${e.state}` : e.type))).toContain(
      'tool:ok',
    );
    expect(events.find((e) => e.type === 'decision')).toMatchObject({ by: 'console:omar' });
    expect(events.find((e) => e.type === 'answer')).toMatchObject({ text: 'Scaled.' });
  });

  it('never shows a secret typed into a message', async () => {
    const { chat } = await setup({ doGenerate: [answer(`echo ${SECRET}`)] });
    const sent = chat.send(viewer, undefined, `is ${SECRET} valid?`);
    if (!sent.ok) throw new Error(sent.error);
    const events = await collect(chat, sent.conversation, idle);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(chat.list())).not.toContain(SECRET);
  });
});
