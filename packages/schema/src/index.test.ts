import { describe, expect, it } from 'vitest';
import { SCHEMA_API_VERSION } from './index.ts';

describe('schema', () => {
  it('exposes the supported apiVersion', () => {
    expect(SCHEMA_API_VERSION).toBe('kodra.io/v1alpha1');
  });
});
