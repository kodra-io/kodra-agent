import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIND_SHA256, KIND_VERSION, kindUrl } from '../src/evals/kind-pin.ts';

// Installs the pinned kind binary for `kodra-agent demo` into KIND_DIR (the agent image),
// and fails unless its SHA-256 matches the pin.
const dir = process.env['KIND_DIR'] ?? '/opt/kodra-kind';
const url = kindUrl(process.arch);
const want = KIND_SHA256[process.arch];
if (!url || !want) throw new Error(`no pinned kind binary for ${process.arch}`);

const res = await fetch(url);
if (!res.ok) throw new Error(`kind ${KIND_VERSION}: HTTP ${String(res.status)}`);
const body = Buffer.from(await res.arrayBuffer());
const got = createHash('sha256').update(body).digest('hex');
if (got !== want) throw new Error(`kind ${KIND_VERSION}: SHA-256 ${got}, expected ${want}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'kind'), body);
chmodSync(join(dir, 'kind'), 0o755);
console.log(`kind ${KIND_VERSION} (${process.arch}): verified, ${join(dir, 'kind')}`);
