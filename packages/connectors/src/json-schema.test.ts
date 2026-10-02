import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentJsonSchemaText, JSON_SCHEMA_FILE } from './json-schema.ts';

describe('committed JSON Schema', () => {
  it('is up to date (run `pnpm schema:export` if this fails)', () => {
    expect(readFileSync(JSON_SCHEMA_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(
      agentJsonSchemaText(),
    );
  });

  it('describes connectors from their manifests', () => {
    const schema = JSON.parse(agentJsonSchemaText()) as {
      properties: { spec: { properties: { connectors: { properties: Record<string, unknown> } } } };
    };
    const ids = Object.keys(schema.properties.spec.properties.connectors.properties);
    expect(ids).toContain('github');
    expect(ids).toContain('teams');
  });
});
