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

const runtime = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mcp-stdio'), command: z.string(), args: z.array(z.string()) }),
  z.strictObject({ type: z.literal('mcp-container'), image: z.string() }),
  z.strictObject({ type: z.literal('builtin'), module: z.string() }),
]);

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
    /** Every tool the runtime exposes. Tools missing here are blocked (SPEC section 6). */
    tools: z.record(z.string(), z.enum(TOOL_RISKS)),
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
