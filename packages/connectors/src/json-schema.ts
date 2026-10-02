import { fileURLToPath } from 'node:url';
import { toAgentJsonSchema } from '@kodra-agent/schema';
import { agentConfigSchema } from './index.ts';

/** Committed at the repo root so editors can reference it. Regenerate with `pnpm schema:export`. */
export const JSON_SCHEMA_FILE = fileURLToPath(
  new URL('../../../schema/kodra-agent.schema.json', import.meta.url),
);

export function agentJsonSchemaText(): string {
  return `${JSON.stringify(toAgentJsonSchema(agentConfigSchema), null, 2)}\n`;
}
