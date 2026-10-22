import type { RepoFiles } from '../ship/detect.ts';

export interface ConfigVar {
  name: string;
  /** The name says it holds a credential, so it belongs in a Secret, not in values. */
  secret: boolean;
  /** Where it is read, at most three files. */
  files: string[];
}

const NAME = '([A-Z][A-Z0-9_]{1,63})';

const READERS: readonly { files: RegExp; patterns: RegExp[] }[] = [
  {
    files: /\.(c|m)?(j|t)sx?$/,
    patterns: [
      new RegExp(`process\\.env\\.${NAME}\\b`, 'g'),
      new RegExp(`process\\.env\\[\\s*['"\`]${NAME}['"\`]\\s*\\]`, 'g'),
      new RegExp(`import\\.meta\\.env\\.${NAME}\\b`, 'g'),
    ],
  },
  {
    files: /\.py$/,
    patterns: [
      new RegExp(`os\\.(?:environ\\.get|getenv)\\(\\s*['"]${NAME}['"]`, 'g'),
      new RegExp(`os\\.environ\\[\\s*['"]${NAME}['"]\\s*\\]`, 'g'),
    ],
  },
  { files: /\.(java|kt)$/, patterns: [new RegExp(`System\\.getenv\\(\\s*"${NAME}"`, 'g')] },
  { files: /\.go$/, patterns: [new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"${NAME}"`, 'g')] },
  {
    // Spring placeholders: ${DB_PASSWORD} or ${DB_PASSWORD:default}.
    files: /(^|\/)application[\w-]*\.(properties|ya?ml)$/,
    patterns: [new RegExp(`\\$\\{${NAME}(?::[^}]*)?\\}`, 'g')],
  },
  {
    files: /(^|\/)\.env\.(example|sample|template|dist)$/,
    patterns: [new RegExp(`^\\s*(?:export\\s+)?${NAME}\\s*=`, 'gm')],
  },
];

const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|(^|_)KEY$|DSN$|(DATABASE|DB|REDIS|MONGO\w*|AMQP|RABBITMQ|POSTGRES\w*|MYSQL\w*|MARIADB\w*)_(URL|URI)$)/;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const SKIP =
  /(^|\/)(node_modules|vendor|dist|build|target|test|tests|__tests__)\/|\.(test|spec)\.\w+$|_test\.go$/;

/** Environment variables the code reads, from source and config files. Values are never read. */
export function findConfigVars(files: RepoFiles): ConfigVar[] {
  const found = new Map<string, ConfigVar>();
  for (const path of files.paths) {
    if (SKIP.test(path)) continue;
    const readers = READERS.filter((r) => r.files.test(path));
    if (readers.length === 0) continue;
    const text = files.read(path);
    if (!text) continue;
    for (const reader of readers) {
      for (const pattern of reader.patterns) {
        for (const m of text.matchAll(pattern)) {
          const name = m[1];
          if (!name) continue;
          const v = found.get(name) ?? { name, secret: isSecretName(name), files: [] };
          if (v.files.length < 3 && !v.files.includes(path)) v.files.push(path);
          found.set(name, v);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
