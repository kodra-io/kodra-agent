import type { RepoFiles } from '../ship/detect.ts';

/** A credential shape to look for (the agent passes its redactor's token patterns). */
export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/** Where a credential is committed. The value itself is never kept. */
export interface SecretHit {
  path: string;
  line: number;
  rule: string;
}

const BINARY =
  /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|jar|war|class|so|dll|exe|woff2?|ttf|eot|mp4|mp3)$/i;
const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock|Cargo\.lock)$/;

/** A reference or template, not a value: ${DB_PASSWORD}, {{ .Values.x }}, <your-token>. */
const PLACEHOLDER = /\$\{|\{\{|<[^>]*>|EXAMPLE|changeme|xxxx/i;

/** Committed credentials, by file, line, and rule. Only the location leaves this function. */
export function scanSecrets(files: RepoFiles, patterns: readonly SecretPattern[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const path of files.paths) {
    if (BINARY.test(path) || LOCKFILE.test(path)) continue;
    const text = files.read(path);
    if (!text) continue;
    for (const { name, pattern } of patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
        if (PLACEHOLDER.test(m[0])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        if (!hits.some((h) => h.path === path && h.line === line))
          hits.push({ path, line, rule: name });
      }
    }
    if (hits.length >= 50) break;
  }
  return hits;
}

/** A committed `.env` file holds real settings, whatever its contents. */
export function committedEnvFiles(files: RepoFiles): string[] {
  return files.paths.filter((p) =>
    /(^|\/)\.env(\.(local|dev|development|prod|production|staging))?$/.test(p),
  );
}
