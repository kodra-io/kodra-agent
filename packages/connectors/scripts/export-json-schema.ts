import { writeFileSync } from 'node:fs';
import { agentJsonSchemaText, JSON_SCHEMA_FILE } from '../src/json-schema.ts';

writeFileSync(JSON_SCHEMA_FILE, agentJsonSchemaText());
console.log(`Wrote ${JSON_SCHEMA_FILE}`);
