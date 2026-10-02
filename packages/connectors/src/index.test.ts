import { describe, expect, it } from 'vitest';
import { SCHEMA_API_VERSION } from '@kodra-agent/schema';
import { registry } from './index.ts';

describe('connector registry', () => {
  it('targets the schema apiVersion', () => {
    expect(registry.apiVersion).toBe(SCHEMA_API_VERSION);
  });

  it('starts empty until manifests land in M1', () => {
    expect(registry.connectors).toEqual([]);
  });
});
