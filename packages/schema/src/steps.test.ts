import { describe, expect, it } from 'vitest';
import { manifestSchema } from './manifest.ts';
import { fillSteps, stepPlaceholders, type SetupStep } from './steps.ts';
import { fixtures } from './test-fixtures.ts';

describe('setup steps', () => {
  const step: SetupStep = {
    text: 'Read {{namespaces}} for {{channel}}.',
    link: '{{url}}/tokens?name={{agentName}}',
    run: {
      linux: 'for ns in {{namespaces}}; do echo "$ns"; done',
      macos: 'for ns in {{namespaces}}; do echo "$ns"; done',
      windows: "foreach ($ns in '{{namespaces}}'.Split(' ')) { $ns }",
    },
  };

  it('fills settings in, lists by spaces or commas, for each system', () => {
    const [filled] = fillSteps([step, { text: 'x', run: { all: '--ns={{namespaces:comma}}' } }], {
      namespaces: ['payments', 'web'],
      channel: '#ops alerts',
      url: 'https://gitlab.example.com',
      agentName: 'courses-agent',
    });
    expect(filled).toEqual({
      text: 'Read payments web for #ops alerts.',
      link: 'https://gitlab.example.com/tokens?name=courses-agent',
      run: {
        linux: 'for ns in payments web; do echo "$ns"; done',
        macos: 'for ns in payments web; do echo "$ns"; done',
        windows: "foreach ($ns in 'payments web'.Split(' ')) { $ns }",
      },
    });
    expect(
      fillSteps([{ text: 'x', run: { all: '--ns={{namespaces:comma}}' } }], {
        namespaces: ['payments', 'web'],
      })[0]?.run,
    ).toEqual({
      linux: '--ns=payments,web',
      macos: '--ns=payments,web',
      windows: '--ns=payments,web',
    });
  });

  it('never puts a value a shell would run into a command; it stays a visible placeholder', () => {
    const [filled] = fillSteps([step], {
      namespaces: ['web', 'x; rm -rf ~'],
      channel: 'two\nlines',
      url: 'https://evil.example.com/$(id)',
    });
    expect(filled?.run?.linux).toBe('for ns in <namespaces>; do echo "$ns"; done');
    expect(filled?.link).toBe('<url>/tokens?name=<agentName>');
    // Sentences take any one line of text, but not a control character.
    expect(filled?.text).toBe('Read web x; rm -rf ~ for <channel>.');
    expect(fillSteps([step], {})[0]?.run?.windows).toBe(
      "foreach ($ns in '<namespaces>'.Split(' ')) { $ns }",
    );
  });

  it('names the placeholders a step uses', () => {
    expect(stepPlaceholders(step).sort()).toEqual(['agentName', 'channel', 'namespaces', 'url']);
  });

  it("refuses steps that use something other than the connector's settings", () => {
    const manifest = structuredClone(fixtures.source) as unknown as Record<string, unknown> & {
      secrets: Record<string, unknown>[];
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    const secret = manifest.secrets[0];
    if (!secret) throw new Error('fixture has no secret');
    secret['steps'] = [{ text: 'Use {{somethingElse}}.' }];
    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('steps use {{somethingElse}}');
    secret['steps'] = [{ text: 'x', run: { linux: 'a', macos: 'b' } }];
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
    secret['steps'] = [{ text: 'x', link: 'http://plain.example.com' }];
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
});
