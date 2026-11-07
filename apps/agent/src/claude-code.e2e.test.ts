import { dynamicTool, generateText, jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeModel, claudeCodeSetup, runClaudeCode } from './claude-code.ts';

/**
 * B7 on a real, signed-in Claude Code. Run with KODRA_CLAUDE_CODE_E2E=1 (and KODRA_CLAUDE_BIN
 * or a `claude` on the PATH). It uses the signed-in account's plan, with the smallest model.
 */
const enabled = process.env['KODRA_CLAUDE_CODE_E2E'] === '1';
const model = process.env['KODRA_CLAUDE_CODE_MODEL'] ?? 'haiku';

describe.skipIf(!enabled)('Claude Code as the model (real binary)', () => {
  const setup = claudeCodeSetup(process.env, undefined);

  it('calls only the agent tools, over MCP, and answers', { timeout: 180_000 }, async () => {
    const calls: unknown[] = [];
    const tools = {
      cluster_pods: dynamicTool({
        description: '[kubernetes, read] Lists the pods in a namespace.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { namespace: { type: 'string' } },
          required: ['namespace'],
        }),
        execute: (input) => {
          calls.push(input);
          return Promise.resolve('pod web-1 CrashLoopBackOff, restarts 7');
        },
      }),
    };
    const steps: number[] = [];
    const result = await runClaudeCode({
      setup,
      model,
      systemPrompt: 'You are a DevOps assistant. Use tools to find facts. Be brief.',
      prompt: 'Which pod is failing in the demo namespace? Use the tool.',
      maxTurns: 4,
      tools,
      timeoutMs: 150_000,
      onStep: (t) => {
        steps.push(t.output);
        return false;
      },
    });
    expect(calls).toEqual([{ namespace: 'demo' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('web-1');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(result.usage.output).toBeGreaterThan(0);
  });

  it('answers a call without tools through the AI SDK', { timeout: 120_000 }, async () => {
    const r = await generateText({
      model: new ClaudeCodeModel(model, setup),
      instructions: 'Reply with exactly the word ok.',
      prompt: 'Say it.',
    });
    expect(r.text.toLowerCase()).toContain('ok');
  });
});
