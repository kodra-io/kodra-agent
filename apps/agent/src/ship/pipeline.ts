import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseTemplateRef,
  readRepoCi,
  readTemplateSpec,
  sharedTemplate,
  type PipelineMode,
  type PlanOptions,
  type RepoCi,
  type SharedUse,
  type SourceProvider,
  type TemplateSpec,
} from '@kodra-agent/templates';
import { TOKEN_PATTERNS } from '../redactor.ts';
import type { Git } from './workspace.ts';

/** At most this many other repos are read, so a long list stays quick. */
const MAX_REPOS = 20;
const MAX_FILE_BYTES = 256 * 1024;

export interface PipelineSource {
  provider: SourceProvider;
  /** The repo being shipped. */
  repo: string;
  settings: Readonly<Record<string, unknown>>;
  /** Every repo or project configured on the connector. */
  configured: readonly string[];
  remote: (repo: string) => string;
}

/**
 * Reads what B1 decides from: the connector's pipeline settings, the CI files of the other
 * configured repos, and the shared template when the connector allows reading it. Only the
 * CI files are fetched (a shallow, blob-less fetch), with the connector's own token.
 */
export async function pipelineInputs(
  git: Git,
  work: string,
  s: PipelineSource,
): Promise<NonNullable<PlanOptions['pipeline']>> {
  const raw = typeof s.settings['pipeline'] === 'string' ? s.settings['pipeline'] : 'auto';
  const mode: PipelineMode = raw === 'shared' || raw === 'standalone' ? raw : 'auto';
  const templateText = s.settings['pipelineTemplate'];
  const template =
    typeof templateText === 'string' && templateText
      ? parseTemplateRef(s.provider, templateText)
      : null;
  const secretPatterns = TOKEN_PATTERNS.map((p) => p.pattern);
  if (mode === 'standalone') return { mode, template, others: [], spec: null, secretPatterns };

  const ciPaths = s.provider === 'github' ? ['.github/workflows'] : ['.gitlab-ci.yml'];
  const others: RepoCi[] = [];
  const peers = s.configured
    .filter((r) => r.toLowerCase() !== s.repo.toLowerCase())
    .slice(0, MAX_REPOS);
  for (const [n, repo] of peers.entries()) {
    const files = await fetchFiles(
      git,
      join(work, `ci-${String(n)}`),
      s.remote(repo),
      null,
      ciPaths,
    );
    if (files) others.push(readRepoCi(s.provider, repo, files));
  }

  // The template is read when the connector names it, or when its repo is one the agent may use.
  const use: SharedUse | null = template ?? sharedTemplate(others)?.use ?? null;
  let spec: TemplateSpec | null = null;
  const allowed =
    use &&
    (template !== null || s.configured.some((r) => r.toLowerCase() === use.source.toLowerCase()));
  if (use && allowed) {
    const files = await fetchFiles(
      git,
      join(work, 'template'),
      s.remote(use.source),
      use.ref,
      use.files.map((f) => f.replace(/^\/+/, '')),
    );
    const specs = Object.values(files ?? {}).map((text) => readTemplateSpec(s.provider, text));
    if (specs.length > 0) {
      spec = {
        inputs: specs.flatMap((x) => x.inputs),
        needs: [...new Set(specs.flatMap((x) => x.needs))].sort(),
        declared: specs.some((x) => x.declared),
      };
    }
  }
  return { mode, template, others, spec, secretPatterns };
}

/** Fetches only `paths` at `ref` (or the default branch); null when the repo cannot be read. */
async function fetchFiles(
  git: Git,
  dir: string,
  url: string,
  ref: string | null,
  paths: readonly string[],
): Promise<Record<string, string> | null> {
  await mkdir(dir, { recursive: true });
  if ((await git.run(['init', '-q'], dir)).code !== 0) return null;
  const fetch = await git.run(
    ['fetch', '-q', '--depth', '1', '--filter=blob:none', url, ref ?? 'HEAD'],
    dir,
    60_000,
  );
  if (fetch.code !== 0) return null;
  const files: Record<string, string> = {};
  for (const path of paths) {
    // A missing path is normal: the repo has no CI of that kind.
    if ((await git.run(['checkout', '-q', 'FETCH_HEAD', '--', path], dir)).code !== 0) continue;
    for (const file of await walk(dir, path)) {
      const full = join(dir, file);
      if ((await stat(full)).size <= MAX_FILE_BYTES) files[file] = await readFile(full, 'utf8');
    }
  }
  return files;
}

async function walk(root: string, path: string): Promise<string[]> {
  const full = join(root, path);
  if (!(await stat(full)).isDirectory()) return [path];
  const out: string[] = [];
  for (const entry of await readdir(full)) out.push(...(await walk(root, `${path}/${entry}`)));
  return out;
}
