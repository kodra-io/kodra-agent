import { z } from 'zod';

/**
 * The contract every connector and model-provider manifest follows (SPEC section 6).
 * Manifests are data: the configurator renders from them and the agent enforces them.
 */

export const CATEGORIES = [
  'model',
  'source',
  'build',
  'deploy',
  'cicd',
  'monitoring',
  'cloud',
  'chat',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ACCESS_LEVELS = ['read-only', 'read-write-approved'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const TOOL_RISKS = ['read', 'write', 'destructive'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KEY = /^[a-z][A-Za-z0-9]*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const PROBE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

const localizedText = z.strictObject({ en: z.string().min(1), ar: z.string().min(1) });
export type LocalizedText = z.infer<typeof localizedText>;

const regexSource = z.string().refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

const configField = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('string'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: localizedText,
    pattern: regexSource.optional(),
    patternHint: localizedText.optional(),
    default: z.string().optional(),
    example: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('url'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: localizedText,
    default: z.url().optional(),
    example: z.url().optional(),
  }),
  z.strictObject({
    kind: z.literal('string-list'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: localizedText,
    pattern: regexSource.optional(),
    patternHint: localizedText.optional(),
    example: z.array(z.string()).optional(),
  }),
  z.strictObject({
    kind: z.literal('integer'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: localizedText,
    min: z.int(),
    max: z.int(),
    default: z.int().optional(),
  }),
]);
export type ConfigField = z.infer<typeof configField>;

const scopesByAccess = z.strictObject({
  always: z.array(z.string().min(1)).optional(),
  'read-only': z.array(z.string().min(1)).optional(),
  'read-write-approved': z.array(z.string().min(1)).optional(),
});

const secretSpec = z.strictObject({
  key: z.string().regex(KEY),
  envVar: z.string().regex(ENV_VAR),
  /** `file` secrets (like a kubeconfig) are referenced as ${file:...} by default. */
  defaultRef: z.enum(['env', 'file']),
  defaultFilePath: z.string().startsWith('/').optional(),
  required: z.boolean(),
  /** For optional secrets: deployment targets where the configurator includes it by default. */
  defaultFor: z.array(z.enum(['compose', 'kubernetes'])).optional(),
  description: localizedText,
  howToCreate: localizedText,
  minimumScopes: scopesByAccess,
  /** Id of the cheap read call `init` and `doctor` use to validate the secret (built in M3). */
  probe: z.string().regex(PROBE),
});
export type SecretSpec = z.infer<typeof secretSpec>;

const requirement = z.strictObject({
  anyOf: z
    .array(
      z.union([
        z.strictObject({ connector: z.string().regex(ID) }),
        z.strictObject({ category: z.enum(CATEGORIES) }),
      ]),
    )
    .min(1),
  message: localizedText,
});
export type Requirement = z.infer<typeof requirement>;

/** Platforms the pinned MCP server binaries are fetched for. */
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'] as const;
export type Platform = (typeof PLATFORMS)[number];

const releaseAsset = z.strictObject({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  archive: z.enum(['none', 'tar.gz', 'zip']),
  /** The executable's name inside the archive (or the file itself when archive is none). */
  binary: z.string().min(1),
});

/** Where a server comes from, pinned by version (and by checksum for binaries). */
const serverSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('github-release'),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    version: z.string().min(1),
    assets: z.partialRecord(z.enum(PLATFORMS), releaseAsset),
  }),
  z.strictObject({
    kind: z.literal('pypi'),
    package: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    command: z.string().min(1),
  }),
]);
export type ServerSource = z.infer<typeof serverSource>;

/**
 * A value filled in when the server starts. Secrets go only into the environment or a
 * temporary 0600 file, never into command-line arguments (visible to other processes).
 */
const valueSource = z.union([
  z.strictObject({ value: z.string() }),
  z.strictObject({ setting: z.string().regex(KEY) }),
  z.strictObject({ secret: z.string().regex(KEY) }),
  z.strictObject({ secretFile: z.string().regex(KEY) }),
]);
export type ValueSource = z.infer<typeof valueSource>;
const argPart = z.union([z.string(), valueSource]);

/** Argument checks the policy engine runs before a tool call (golden rules 4 and 6). */
const toolGuard = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('arg-in-setting'),
    /** Tool argument, like `namespace`. */
    arg: z.string().min(1),
    /** List setting it must be one of, like `namespaces`. */
    setting: z.string().regex(KEY),
    /** When true, a call without the argument is blocked too. */
    required: z.boolean(),
  }),
]);
export type ToolGuard = z.infer<typeof toolGuard>;

const runtime = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('mcp-stdio'),
    source: serverSource,
    args: z.array(argPart),
    /** Extra arguments per access level, like a read-only flag. */
    accessArgs: z.partialRecord(z.enum(ACCESS_LEVELS), z.array(z.string())).optional(),
    /** Arguments added only when an optional secret is set. */
    secretArgs: z
      .array(z.strictObject({ secret: z.string().regex(KEY), args: z.array(argPart) }))
      .optional(),
    /** The server's whole environment, besides a minimal PATH. Missing secrets are left out. */
    env: z.record(z.string().regex(ENV_VAR), valueSource),
    /** Non-secret variables passed through from the agent when set, like KUBERNETES_SERVICE_HOST. */
    inheritEnv: z.array(z.string().regex(ENV_VAR)).optional(),
    /** A config file written to a private temp folder and passed as `arg <path>`. */
    configFile: z.strictObject({ arg: z.string().min(1), content: z.string() }).optional(),
  }),
  z.strictObject({ type: z.literal('mcp-container'), image: z.string() }),
  z.strictObject({ type: z.literal('builtin'), module: z.string() }),
]);
export type McpStdioRuntime = Extract<z.infer<typeof runtime>, { type: 'mcp-stdio' }>;

export const manifestSchema = z
  .strictObject({
    id: z.string().regex(ID),
    displayName: z.string().min(1),
    category: z.enum(CATEGORIES),
    status: z.enum(['available', 'coming-soon']),
    description: localizedText,
    /** Empty for connectors where access does not apply (model providers, chat). */
    accessLevels: z.array(z.enum(ACCESS_LEVELS)),
    requires: z.array(requirement),
    configFields: z.array(configField),
    secrets: z.array(secretSpec),
    /**
     * Read-only connectivity check `doctor` runs even when the connector has no secret,
     * like pinging Prometheus or the Docker socket.
     */
    healthProbe: z.string().regex(PROBE).optional(),
    /** Every tool the runtime exposes. Tools missing here are blocked (SPEC section 6). */
    tools: z.record(z.string(), z.enum(TOOL_RISKS)),
    /** Argument checks per tool, enforced by the policy engine. */
    guards: z.record(z.string(), z.array(toolGuard)).optional(),
    /** null until the MCP server is chosen and documented (M4). */
    runtime: runtime.nullable(),
    permissionsSummary: z.strictObject({
      always: z.array(localizedText).optional(),
      'read-only': z.array(localizedText).optional(),
      'read-write-approved': z.array(localizedText).optional(),
    }),
  })
  .superRefine((m, ctx) => {
    const keys = [...m.configFields.map((f) => f.key), ...m.secrets.map((s) => s.key)];
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({ code: 'custom', message: `duplicate field keys: ${dupes.join(', ')}` });
    }
    for (const level of m.accessLevels) {
      if (!m.permissionsSummary[level]?.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['permissionsSummary', level],
          message: `needs a summary for access level ${level}`,
        });
      }
    }
    if (m.accessLevels.length === 0 && !m.permissionsSummary.always?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissionsSummary', 'always'],
        message: 'needs an "always" summary when there are no access levels',
      });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

/** Identity helper that type-checks a manifest literal. */
export function defineManifest(manifest: Manifest): Manifest {
  return manifest;
}
