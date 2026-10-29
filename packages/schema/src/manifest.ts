import { z } from 'zod';
import { GLOBAL_PLACEHOLDERS, setupStepSchema, stepPlaceholders } from './steps.ts';

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
  'database',
  'chat',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * `available` is stable. `preview` works but is less tested and may change: it is off by
 * default and shown under "More connectors". `coming-soon` cannot be enabled.
 */
export const CONNECTOR_STATUSES = ['available', 'preview', 'coming-soon'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const ACCESS_LEVELS = ['read-only', 'read-write-approved'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const TOOL_RISKS = ['read', 'write', 'destructive'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KEY = /^[a-z][A-Za-z0-9]*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const PROBE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** User-facing copy, in plain English. */
const copy = z.string().min(1);

/** How to get the value, with commands per operating system (M28); see steps.ts. */
const steps = z.array(setupStepSchema).min(1).optional();

/**
 * A secret that is a file, like a kubeconfig or an SSH private key: the console takes it
 * pasted or uploaded, checks its shape, and saves it as a file the config refers to.
 */
export const SECRET_FORMATS = ['kubeconfig', 'ssh-private-key'] as const;
export type SecretFormat = (typeof SECRET_FORMATS)[number];

const regexSource = z.string().refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

/**
 * A field of one entry in an `entries` setting. `requiredWith` makes it required when another
 * field of the entry is set (a tunnel's user, once its host is).
 */
const entryField = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('string'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    requiredWith: z.string().regex(KEY).optional(),
    description: copy,
    pattern: regexSource.optional(),
    patternHint: copy.optional(),
    example: z.string().optional(),
    steps,
  }),
  z.strictObject({
    kind: z.literal('integer'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    requiredWith: z.string().regex(KEY).optional(),
    description: copy,
    min: z.int(),
    max: z.int(),
    default: z.int().optional(),
  }),
  z.strictObject({
    kind: z.literal('choice'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    options: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('boolean'),
    key: z.string().regex(KEY),
    description: copy,
    default: z.boolean(),
  }),
  /** A secret reference, never a value; see `envPrefix`. */
  z.strictObject({
    kind: z.literal('secret'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    requiredWith: z.string().regex(KEY).optional(),
    description: copy,
    howToCreate: copy,
    /** The variable's suffix, like PASSWORD. */
    envVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    format: z.enum(SECRET_FORMATS).optional(),
    steps,
  }),
]);

const configField = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('string'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    pattern: regexSource.optional(),
    patternHint: copy.optional(),
    default: z.string().optional(),
    example: z.string().optional(),
    steps,
  }),
  z.strictObject({
    kind: z.literal('url'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    default: z.url().optional(),
    example: z.url().optional(),
    steps,
  }),
  z.strictObject({
    kind: z.literal('string-list'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    pattern: regexSource.optional(),
    patternHint: copy.optional(),
    default: z.array(z.string()).optional(),
    example: z.array(z.string()).optional(),
    steps,
  }),
  z.strictObject({
    kind: z.literal('integer'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    min: z.int(),
    max: z.int(),
    default: z.int().optional(),
  }),
  /**
   * A list of named entries, like one per database. Each entry has a `name` (lowercase
   * letters, digits, and hyphens, unique in the list) that tools, guards, and dashboard cards
   * refer to, plus the fields below.
   */
  z.strictObject({
    kind: z.literal('entries'),
    key: z.string().regex(KEY),
    required: z.boolean(),
    description: copy,
    fields: z.array(entryField).min(1),
    /** What one entry is, for buttons like "Add database". */
    noun: copy,
    /**
     * An entry's secrets are environment variables named for it: `<envPrefix><NAME>_<envVar>`,
     * like KODRA_DB_ORDERS_PASSWORD. A reference to any other variable is refused, so an entry
     * can never be pointed at another connector's secret.
     */
    envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*_$/),
    max: z.int().min(1).max(50),
  }),
]);
export type ConfigField = z.infer<typeof configField>;
export type EntryField = z.infer<typeof entryField>;

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
  /**
   * For optional secrets: deployment targets where it is required after all (a kubeconfig is
   * optional inside the cluster, but needed on Docker Compose). Use isSecretRequired().
   */
  requiredOn: z.array(z.enum(['compose', 'kubernetes'])).optional(),
  description: copy,
  howToCreate: copy,
  minimumScopes: scopesByAccess,
  /** Id of the cheap read call `init` and `doctor` use to validate the secret (built in M3). */
  probe: z.string().regex(PROBE),
  format: z.enum(SECRET_FORMATS).optional(),
  steps,
});
export type SecretSpec = z.infer<typeof secretSpec>;

/** Whether a secret must be set for this deployment target. */
export function isSecretRequired(
  spec: Pick<SecretSpec, 'required' | 'requiredOn'>,
  target: 'compose' | 'kubernetes',
): boolean {
  return spec.required || (spec.requiredOn ?? []).includes(target);
}

const requirement = z.strictObject({
  anyOf: z
    .array(
      z.union([
        z.strictObject({ connector: z.string().regex(ID) }),
        z.strictObject({ category: z.enum(CATEGORIES) }),
      ]),
    )
    .min(1),
  message: copy,
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
  z.strictObject({
    kind: z.literal('npm'),
    package: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** The package's bin name to run. */
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
  /** A config setting; `suffix` is appended, like `/api/v4` after a GitLab URL. */
  z.strictObject({
    setting: z.string().regex(KEY),
    suffix: z.string().optional(),
    /** Read it from a connector this manifest `requires`. */
    from: z.string().regex(ID).optional(),
  }),
  /**
   * A secret value. With `from`, another connector's secret; allowed only for a connector
   * this manifest `requires` (GitHub Actions uses the GitHub token).
   */
  z.strictObject({ secret: z.string().regex(KEY), from: z.string().regex(ID).optional() }),
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
    /** Entries are prefixes too: `team-a` allows `team-a` and `team-a/anything`. */
    prefix: z.boolean().optional(),
    /** The argument is a Kubernetes namespace, so it places the call in an environment. */
    scope: z.literal('namespace').optional(),
  }),
  z.strictObject({
    kind: z.literal('repo-in-setting'),
    /** Owner argument, like `owner`; omit when the repo argument holds the full path. */
    ownerArg: z.string().min(1).optional(),
    /** Repo argument, like `repo` or `project_id`. */
    repoArg: z.string().min(1),
    /** List setting of `owner/repo` (or `group/project`) entries. */
    setting: z.string().regex(KEY),
    /** Read the setting from a connector this manifest `requires` (GitHub Actions uses GitHub's repos). */
    from: z.string().regex(ID).optional(),
  }),
  z.strictObject({
    /**
     * Never the agent's own objects (M11): its Deployment and pods, config, settings ConfigMap,
     * Secret, and ServiceAccount. A missing namespace counts as the agent's own, which is the
     * default for a server running in the agent's pod.
     */
    kind: z.literal('not-self'),
    namespaceArg: z.string().min(1),
    /** The object's name; with neither this nor resourceArg, the whole namespace is off limits. */
    nameArg: z.string().min(1).optional(),
    /** An argument holding whole manifests (YAML or JSON), read for their namespace and name. */
    resourceArg: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('not-default-branch'),
    /** Branch argument, like `branch`. A missing branch means the default branch: blocked. */
    branchArg: z.string().min(1),
    ownerArg: z.string().min(1).optional(),
    repoArg: z.string().min(1),
  }),
]);
export type ToolGuard = z.infer<typeof toolGuard>;

/** Argument names that together name a repo: ['owner', 'repo'] is joined as owner/repo. */
const repoArgs = z.array(z.string().min(1)).min(1);

/**
 * Where a source-control tool's arguments are, so a proposed change can show a readable
 * preview (a diff for file edits) and check each file again before it writes it.
 */
const changeStep = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('branch'),
    repo: repoArgs,
    branch: z.string(),
    /** The branch it starts from; the default branch when left out. */
    from: z.string(),
  }),
  z.strictObject({
    kind: z.literal('file'),
    repo: repoArgs,
    branch: z.string(),
    path: z.string(),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('files'),
    repo: repoArgs,
    branch: z.string(),
    /** The array argument; each item has `path` and `content` keys. */
    files: z.string(),
    path: z.string(),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('pull-request'),
    repo: repoArgs,
    head: z.string(),
    base: z.string(),
    title: z.string(),
  }),
]);
export type ChangeStep = z.infer<typeof changeStep>;

const stdioRuntime = z.strictObject({
  type: z.literal('mcp-stdio'),
  /** Names the server when a connector runs several (like `eks` and `cloudwatch`). */
  name: z.string().regex(ID).optional(),
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
  /**
   * Start this server only if a list setting includes a value (AWS: `services` includes
   * `cloudwatch`). Unset settings start it, so older configs keep every server.
   */
  onlyIf: z.strictObject({ setting: z.string().regex(KEY), includes: z.string() }).optional(),
});
export type McpStdioRuntime = z.infer<typeof stdioRuntime>;

/**
 * An MCP server inside the agent itself, for checks no outside server does safely (database
 * health, with fixed queries only). Its tools are classified and guarded like any other.
 */
const builtinRuntime = z.strictObject({
  type: z.literal('builtin'),
  module: z.enum(['databases']),
});
export type BuiltinRuntime = z.infer<typeof builtinRuntime>;

const runtime = z.union([
  stdioRuntime,
  /** Several servers for one connector; their tool names must not overlap. */
  z.array(stdioRuntime).min(2),
  z.strictObject({ type: z.literal('mcp-container'), image: z.string() }),
  builtinRuntime,
]);

/** A dotted path into a JSON item, like `status` or `user.name`. */
const jsonPath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);

/**
 * How the console dashboard reads a tool's output. Each kind is generic, never per
 * connector: `pods` and `deployments` read a kubectl-style table, `events` a YAML list of
 * Kubernetes events, and `runs` a JSON list of pipeline or workflow runs. `workload` reads a
 * pods table and keeps the pods of one named workload (a `scoped` forEach entry).
 */
const dashboardView = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pods') }),
  z.strictObject({ kind: z.literal('workload') }),
  z.strictObject({ kind: z.literal('deployments') }),
  z.strictObject({ kind: z.literal('events') }),
  /** A database's health as JSON, from the built-in Databases connector. */
  z.strictObject({ kind: z.literal('database') }),
  /**
   * A JSON list of jobs with a status word (like Jenkins colors), mapped to a state by
   * `states`; unmapped words count as `other`. `scope` keeps only items whose field is in a
   * list setting, or under one of its entries, like the connector's guards.
   */
  z.strictObject({
    kind: z.literal('jobs'),
    items: jsonPath.optional(),
    fields: z.strictObject({ name: jsonPath, status: jsonPath, url: jsonPath }),
    states: z.record(z.string(), z.enum(['passed', 'failed', 'running', 'other'])),
    scope: z.strictObject({ field: jsonPath, setting: z.string().regex(KEY) }).optional(),
  }),
  z.strictObject({
    kind: z.literal('runs'),
    /** Where the list is, when the output is an object rather than a list. */
    items: jsonPath.optional(),
    fields: z.strictObject({
      id: jsonPath,
      /** The workflow's name, when there is one. */
      name: jsonPath.optional(),
      ref: jsonPath,
      /** Checked in order; the first that is set wins (a conclusion, then a status). */
      status: z.array(jsonPath).min(1),
      url: jsonPath,
      at: jsonPath,
    }),
  }),
]);
export type DashboardView = z.infer<typeof dashboardView>;

/**
 * A card on the console dashboard: one read-only tool call (or one per entry of a setting),
 * made without the model, through the same policy checks and redaction as the agent's.
 */
const dashboardPanel = z.strictObject({
  id: z.string().regex(KEY),
  title: copy,
  tool: z.string().min(1),
  /** Fixed arguments. */
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /**
   * Calls the tool once per entry of a list setting (this connector's, or `from` one it
   * requires), passing the entry as `arg`. `owner/repo` entries can be split into two args.
   */
  forEach: z
    .strictObject({
      setting: z.string().regex(KEY),
      from: z.string().regex(ID).optional(),
      arg: z.string().min(1),
      /** For `owner/repo` entries: the arg for the repo name (`arg` gets the owner). */
      repoArg: z.string().min(1).optional(),
      /**
       * For `scope/name` entries, like `prod/mariadb`: `arg` gets the scope, and the view
       * keeps only what belongs to the name. Only with the `workload` view.
       */
      scoped: z.boolean().optional(),
    })
    .optional(),
  view: dashboardView,
});
export type DashboardPanel = z.infer<typeof dashboardPanel>;

/** US dollars per million tokens. */
export const modelPrice = z.strictObject({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof modelPrice>;

export const manifestSchema = z
  .strictObject({
    id: z.string().regex(ID),
    displayName: z.string().min(1),
    category: z.enum(CATEGORIES),
    status: z.enum(CONNECTOR_STATUSES),
    description: copy,
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
    /**
     * Tools a server offers that the host never exposes, for servers without their own
     * tool filter. Documented per connector in docs/connectors/<id>.md.
     */
    hiddenTools: z.array(z.string()).optional(),
    /** Argument checks per tool, enforced by the policy engine. */
    guards: z.record(z.string(), z.array(toolGuard)).optional(),
    /**
     * The forge API the agent reads directly: each configured repo's default branch (for
     * not-default-branch guards), and file contents (for the diff in a proposed change).
     */
    defaultBranchLookup: z.enum(['github', 'gitlab']).optional(),
    /** Source-control tools a proposed change can preview, by tool name. */
    changeSteps: z.record(z.string(), changeStep).optional(),
    /** Cards on the console dashboard, each from one read tool. */
    dashboard: z.array(dashboardPanel).optional(),
    /**
     * How the connector's credential is checked for more access than the agent needs (M29):
     * when it is tested (doctor, init, the console) and at startup. A broad one is refused
     * unless the connector's entry sets allowBroadCredentials.
     */
    credentialScope: z.enum(['kubernetes-rbac']).optional(),
    /**
     * After an approved change with `tool` (M29b): read the object with `read.tool` (the
     * change's `copyArgs`) until the number at `have` reaches the one at `want`, for up to
     * `timeoutSeconds`. If it does not, the agent says so and names the change that puts
     * `rollbackArg` back to its value before the change (which needs approval again).
     */
    rolloutCheck: z
      .strictObject({
        tool: z.string().min(1),
        read: z.strictObject({
          tool: z.string().min(1),
          copyArgs: z.array(z.string().min(1)).min(1),
        }),
        want: z.array(z.string().min(1)).min(1),
        have: z.array(z.string().min(1)).min(1),
        rollbackArg: z.string().min(1),
        timeoutSeconds: z.int().min(30).max(1800).default(300),
      })
      .optional(),
    /**
     * A scaling tool whose big cuts are treated as destructive (M29): to zero, or by more
     * than half of what the object runs now. `current` reads the object with the same
     * arguments (`copyArgs`) and finds its replicas at `path` in the YAML it returns.
     */
    scaleLimit: z
      .strictObject({
        tool: z.string().min(1),
        replicasArg: z.string().min(1),
        current: z.strictObject({
          tool: z.string().min(1),
          copyArgs: z.array(z.string().min(1)).min(1),
          path: z.array(z.string().min(1)).min(1),
        }),
      })
      .optional(),
    /**
     * Model providers: list prices per model, for the console's estimated cost. Dated and
     * sourced, because prices change; the config can override them (spec.console.pricing).
     */
    pricing: z
      .strictObject({
        asOf: z.iso.date(),
        source: z.url(),
        models: z.record(z.string().min(1), modelPrice),
      })
      .optional(),
    /** null until the MCP server is chosen and documented (M4). */
    runtime: runtime.nullable(),
    permissionsSummary: z.strictObject({
      always: z.array(copy).optional(),
      'read-only': z.array(copy).optional(),
      'read-write-approved': z.array(copy).optional(),
    }),
  })
  .superRefine((m, ctx) => {
    if (m.rolloutCheck) {
      if (m.tools[m.rolloutCheck.tool] !== 'write') {
        ctx.addIssue({
          code: 'custom',
          path: ['rolloutCheck', 'tool'],
          message: 'must be a write tool',
        });
      }
      if (m.tools[m.rolloutCheck.read.tool] !== 'read') {
        ctx.addIssue({
          code: 'custom',
          path: ['rolloutCheck', 'read', 'tool'],
          message: 'must be a read tool',
        });
      }
    }
    if (m.scaleLimit) {
      if (m.tools[m.scaleLimit.tool] !== 'write') {
        ctx.addIssue({
          code: 'custom',
          path: ['scaleLimit', 'tool'],
          message: 'must be a write tool',
        });
      }
      if (m.tools[m.scaleLimit.current.tool] !== 'read') {
        ctx.addIssue({
          code: 'custom',
          path: ['scaleLimit', 'current', 'tool'],
          message: 'must be a read tool',
        });
      }
    }
    const keys = [...m.configFields.map((f) => f.key), ...m.secrets.map((s) => s.key)];
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({ code: 'custom', message: `duplicate field keys: ${dupes.join(', ')}` });
    }
    for (const [i, field] of m.configFields.entries()) {
      if (field.kind !== 'entries') continue;
      const own = field.fields.map((f) => f.key);
      if (own.includes('name') || own.some((k, j) => own.indexOf(k) !== j)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configFields', i, 'fields'],
          message: 'entry field keys must be unique, and every entry has its own `name`',
        });
      }
      for (const f of field.fields) {
        if ('requiredWith' in f && f.requiredWith !== undefined && !own.includes(f.requiredWith)) {
          ctx.addIssue({
            code: 'custom',
            path: ['configFields', i, 'fields'],
            message: `${f.key} is required with ${f.requiredWith}, which is not a field`,
          });
        }
      }
      // An entry's secret is checked by the connector's health probe, like a connection test.
      if (field.fields.some((f) => f.kind === 'secret') && !m.healthProbe) {
        ctx.addIssue({
          code: 'custom',
          path: ['healthProbe'],
          message: 'entries with secrets need a healthProbe to check them',
        });
      }
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
    for (const tool of Object.keys(m.changeSteps ?? {})) {
      if (!(tool in m.tools)) {
        ctx.addIssue({
          code: 'custom',
          path: ['changeSteps', tool],
          message: `${tool} is not in tools`,
        });
      }
    }
    for (const [i, panel] of (m.dashboard ?? []).entries()) {
      // The dashboard never changes anything: its tools must be classified as reads.
      if (m.tools[panel.tool] !== 'read') {
        ctx.addIssue({
          code: 'custom',
          path: ['dashboard', i, 'tool'],
          message: `${panel.tool} is not a read tool of this connector`,
        });
      }
      // A workload card reads one named workload: it needs `scope/name` entries, and only it.
      if ((panel.view.kind === 'workload') !== (panel.forEach?.scoped === true)) {
        ctx.addIssue({
          code: 'custom',
          path: ['dashboard', i, 'forEach', 'scoped'],
          message: 'the workload view and scoped entries go together',
        });
      }
      if (panel.forEach?.scoped && panel.forEach.repoArg) {
        ctx.addIssue({
          code: 'custom',
          path: ['dashboard', i, 'forEach', 'repoArg'],
          message: 'scoped entries cannot also be split into a repo arg',
        });
      }
    }
    if (m.changeSteps && !m.defaultBranchLookup) {
      ctx.addIssue({
        code: 'custom',
        path: ['changeSteps'],
        message: 'change previews read files, so they need defaultBranchLookup',
      });
    }
    // Steps may use the connector's settings (an entry's steps, the entry's fields) only.
    const known = (keys: string[]) => new Set<string>([...keys, ...GLOBAL_PLACEHOLDERS]);
    const top = known(m.configFields.map((f) => f.key));
    const checkSteps = (
      list: z.infer<typeof steps>,
      allowed: ReadonlySet<string>,
      path: (string | number)[],
    ) => {
      for (const step of list ?? []) {
        for (const name of stepPlaceholders(step)) {
          if (!allowed.has(name)) {
            ctx.addIssue({ code: 'custom', path, message: `steps use {{${name}}}, not a setting` });
          }
        }
      }
    };
    for (const [i, s] of m.secrets.entries()) checkSteps(s.steps, top, ['secrets', i, 'steps']);
    for (const [i, f] of m.configFields.entries()) {
      if (f.kind === 'entries') {
        const own = known(['name', ...f.fields.map((x) => x.key)]);
        for (const [j, x] of f.fields.entries()) {
          if ('steps' in x) checkSteps(x.steps, own, ['configFields', i, 'fields', j, 'steps']);
        }
      } else if ('steps' in f) checkSteps(f.steps, top, ['configFields', i, 'steps']);
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

/** Whether a connector can be enabled: stable or preview. */
export function isUsable(manifest: Pick<Manifest, 'status'>): boolean {
  return manifest.status !== 'coming-soon';
}

/** Identity helper that type-checks a manifest literal. */
export function defineManifest(manifest: Manifest): Manifest {
  return manifest;
}

/** The stdio MCP servers a manifest runs: none, one, or several. */
export function stdioRuntimes(manifest: Pick<Manifest, 'runtime'>): McpStdioRuntime[] {
  const runtime = manifest.runtime;
  if (runtime === null) return [];
  if (Array.isArray(runtime)) return runtime;
  return runtime.type === 'mcp-stdio' ? [runtime] : [];
}
