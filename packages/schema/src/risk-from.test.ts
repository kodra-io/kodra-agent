import { describe, expect, it } from 'vitest';
import { manifestSchema } from './manifest.ts';
import { fixtures } from './test-fixtures.ts';

describe('riskFrom', () => {
  const withTool = (risk: string, kind = 'aws-cli') => ({
    ...structuredClone(fixtures.source),
    tools: { call_aws: risk },
    riskFrom: { call_aws: { kind, commandArg: 'cli_command' } },
  });

  it('takes a tool classified write, so it is never offered as a plain read', () => {
    expect(manifestSchema.safeParse(withTool('write')).success).toBe(true);
    for (const risk of ['read', 'destructive']) {
      const result = manifestSchema.safeParse(withTool(risk));
      expect(JSON.stringify(result.error?.issues)).toContain('must be classified write');
    }
  });

  it('knows only the AWS CLI', () => {
    expect(manifestSchema.safeParse(withTool('write', 'shell')).success).toBe(false);
  });
});
