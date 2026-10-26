import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { z } from 'zod';

/**
 * A failure scenario (L3): a broken workload on kind, how the agent is asked about it, the
 * root-cause facts a right answer states, and what it must not do. The evaluation suite
 * (`pnpm eval`) and `kodra-agent demo` both read these from evals/scenarios/<id>/.
 */

export const SCENARIOS_DIR = fileURLToPath(
  new URL('../../../../evals/scenarios/', import.meta.url),
);

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const regex = z.string().refine(
  (s) => {
    try {
      new RegExp(s, 'i');
      return true;
    } catch {
      return false;
    }
  },
  { error: 'must be a valid regular expression' },
);

/** What must be true of some pod in the namespace before the agent is asked. */
const readySchema = z.strictObject({
  /** waiting and terminated look at container states; pending at the pod phase. */
  state: z.enum(['waiting', 'terminated', 'pending', 'running', 'not-ready', 'restarted']),
  /** The container state's reason, like CrashLoopBackOff or OOMKilled. */
  reason: z.string().optional(),
  /** Only pods with this label value for `app`. */
  app: z.string().optional(),
});
export type ReadyCondition = z.infer<typeof readySchema>;

const alertSchema = z.strictObject({
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
});

export const scenarioSchema = z.strictObject({
  id: z.string().regex(ID),
  title: z.string().min(1),
  /** What a person sees: an alert that fired, or a question someone asks. */
  trigger: z.union([
    z.strictObject({ question: z.string().min(1) }),
    z.strictObject({ alert: alertSchema }),
  ]),
  ready: z.array(readySchema).min(1),
  /** Each fact passes when any of its patterns is in the answer (case-insensitive). */
  expect: z.array(z.strictObject({ fact: z.string().min(1), any: z.array(regex).min(1) })).min(1),
  /** Things a right answer never does: call a tool (with arguments), or recommend an action. */
  mustNot: z
    .array(
      z.union([
        z.strictObject({ why: z.string().min(1), tool: z.string().min(1), args: regex.optional() }),
        z.strictObject({ why: z.string().min(1), says: regex }),
      ]),
    )
    .default([]),
  /** Applied after the first manifests are ready, like a new release (optional). */
  update: z.boolean().default(false),
});
export type Scenario = z.infer<typeof scenarioSchema> & {
  /** Every manifest in manifests.yaml, all in the namespace named after the scenario. */
  manifests: Record<string, unknown>[];
  /** update.yaml, when `update` is set. */
  updates: Record<string, unknown>[];
};

function documents(text: string, file: string): Record<string, unknown>[] {
  return parseAllDocuments(text).map((d, i) => {
    if (d.errors.length > 0)
      throw new Error(`${file} document ${String(i + 1)}: ${d.errors[0]?.message ?? ''}`);
    const value = d.toJS() as unknown;
    if (!value || typeof value !== 'object')
      throw new Error(`${file} document ${String(i + 1)} is empty`);
    return value as Record<string, unknown>;
  });
}

/** Each manifest is in the scenario's own namespace, so scenarios never touch each other. */
function checkNamespaces(id: string, docs: Record<string, unknown>[], file: string): void {
  for (const doc of docs) {
    const kind = String(doc['kind']);
    const meta = (doc['metadata'] ?? {}) as Record<string, unknown>;
    if (kind === 'Namespace') {
      if (meta['name'] !== id) throw new Error(`${file}: the Namespace must be named ${id}`);
    } else if (meta['namespace'] !== id) {
      throw new Error(`${file}: ${kind} ${String(meta['name'])} must be in namespace ${id}`);
    }
  }
}

export async function loadScenario(dir: string): Promise<Scenario> {
  const file = join(dir, 'scenario.yaml');
  const parsed = scenarioSchema.safeParse(parse(await readFile(file, 'utf8')) as unknown);
  if (!parsed.success) {
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const scenario = parsed.data;
  const manifests = documents(
    await readFile(join(dir, 'manifests.yaml'), 'utf8'),
    'manifests.yaml',
  );
  checkNamespaces(scenario.id, manifests, `${scenario.id}/manifests.yaml`);
  if (!manifests.some((m) => m['kind'] === 'Namespace')) {
    throw new Error(`${scenario.id}/manifests.yaml: add the Namespace ${scenario.id}`);
  }
  const updates = scenario.update
    ? documents(await readFile(join(dir, 'update.yaml'), 'utf8'), 'update.yaml')
    : [];
  checkNamespaces(scenario.id, updates, `${scenario.id}/update.yaml`);
  return { ...scenario, manifests, updates };
}

/** Every scenario, sorted by id; `only` keeps the ones named, in that order. */
export async function loadScenarios(
  only?: readonly string[],
  dir: string = SCENARIOS_DIR,
): Promise<Scenario[]> {
  const ids = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const all = await Promise.all(ids.map((id) => loadScenario(join(dir, id))));
  const mismatched = all.filter((s, i) => s.id !== ids[i]);
  if (mismatched.length > 0) {
    throw new Error(
      `scenario ids must match their folder: ${mismatched.map((s) => s.id).join(', ')}`,
    );
  }
  if (!only || only.length === 0) return all;
  const unknown = only.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`no such scenario: ${unknown.join(', ')}`);
  return only.map((id) => all.find((s) => s.id === id) as Scenario);
}
