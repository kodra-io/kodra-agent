import { z } from 'zod';
import { checkDependencies } from './dependencies.ts';
import { entriesSchema } from './entries.ts';
import {
  isUsable,
  modelPrice,
  type ConfigField,
  type Manifest,
  type ModelPrice,
} from './manifest.ts';
import { isCalendarDate, isTimeZone, weeklyMinute } from './freeze.ts';
import { minuteOfDay, SCHEDULE_DAYS, type ScheduleDay } from './schedule.ts';
import { policyProblems, PROFILES, type Profile } from './policy.ts';
import { secretRefSchema } from './secret-ref.ts';

export const API_GROUP = 'kodra.io';
export const SCHEMA_API_VERSION = 'kodra.io/v1alpha1';
export const SUPPORTED_API_VERSIONS: readonly string[] = [SCHEMA_API_VERSION];
export const DEFAULT_AUDIT_PATH = '/var/lib/kodra-agent/audit.jsonl';

/** Why an apiVersion is not accepted (phrased to follow the field name), or null. */
export function apiVersionProblem(apiVersion: unknown): string | null {
  if (typeof apiVersion !== 'string' || apiVersion === '') {
    return `is required. Set it to ${SCHEMA_API_VERSION}.`;
  }
  if (SUPPORTED_API_VERSIONS.includes(apiVersion)) return null;
  if (!apiVersion.startsWith(`${API_GROUP}/`)) {
    return `${apiVersion} is not a Kodra AI Agent config. Expected ${SCHEMA_API_VERSION}.`;
  }
  return (
    `${apiVersion} is not supported by this agent, which reads ` +
    `${SUPPORTED_API_VERSIONS.join(', ')}. Upgrade kodra-agent or regenerate the config.`
  );
}

const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http or https URL' });
const absolutePath = z
  .string()
  .regex(/^\/[^\0]*$/, 'must be an absolute path, like /var/lib/kodra-agent/audit.jsonl');

// Helm release names cap at 53 characters, and the name is reused for Kubernetes objects.
const agentName = z
  .string()
  .regex(
    /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/,
    'must be lowercase letters, digits, and hyphens (start and end with a letter or digit, at most 53 characters)',
  );

/** Console approvers: `console:<name>`, each signing in with their own token. */
export const CONSOLE_APPROVER_PREFIX = 'console:';
const CONSOLE_APPROVER = /^console:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// Slack handles like @omar, Slack user ids like U0123ABCD, or console approvers like console:omar.
const approver = z
  .string()
  .regex(
    /^(@[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[UW][A-Z0-9]{2,}|console:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/,
    'must be a Slack handle like @omar, a Slack user id like U0123ABCD, or a console approver like console:omar',
  );

/** Whether an approver entry is a console approver (`console:omar`). */
export function isConsoleApprover(entry: string): boolean {
  return CONSOLE_APPROVER.test(entry);
}

/** The console admin: signs in with a password, not a token, and approves where it is listed. */
export const CONSOLE_ADMIN = 'console:admin';

/** Whether an approver entry is a console approver with a sign-in token (all but the admin). */
export function isTokenApprover(entry: string): boolean {
  return isConsoleApprover(entry) && entry !== CONSOLE_ADMIN;
}

/** The environment variable holding a console approver's sign-in token: console:on-call -> KODRA_CONSOLE_TOKEN_ON_CALL. */
export function consoleApproverTokenEnv(entry: string): string {
  return `KODRA_CONSOLE_TOKEN_${entry.slice(CONSOLE_APPROVER_PREFIX.length).toUpperCase().replaceAll('-', '_')}`;
}

const awsRegion = z
  .string()
  .regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'must be an AWS region, like eu-central-1');

const modelName = z.string().min(1, 'needs a model id from your provider');

export const modelSchema = z.discriminatedUnion(
  'provider',
  [
    unknownKeys(
      {
        provider: z.literal('anthropic'),
        name: modelName,
        apiKey: secretRefSchema,
        baseUrl: httpUrl.optional(),
      },
      'key',
    ),
    unknownKeys(
      {
        provider: z.literal('openai'),
        name: modelName,
        apiKey: secretRefSchema,
        baseUrl: httpUrl.optional(),
      },
      'key',
    ),
    unknownKeys(
      {
        provider: z.literal('azure-openai'),
        name: modelName,
        apiKey: secretRefSchema,
        endpoint: httpUrl,
        deployment: z.string().min(1),
      },
      'key',
    ),
    unknownKeys(
      {
        provider: z.literal('bedrock'),
        name: modelName,
        region: awsRegion,
      },
      'key',
    ),
    unknownKeys(
      {
        provider: z.literal('ollama'),
        name: modelName,
        baseUrl: httpUrl,
      },
      'key',
    ),
  ],
  { error: 'provider must be one of anthropic, openai, azure-openai, bedrock, ollama' },
);
export type ModelConfig = z.infer<typeof modelSchema>;
export type ModelProvider = ModelConfig['provider'];

/** Approval rules; left out, the profile decides (see resolvePolicy). */
const approvalRules = {
  /** How many different approvers a change needs. */
  minApprovers: z.int().min(1).max(5).optional(),
  /** Whether the person who asked for a change may approve it. */
  allowSelfApproval: z.boolean().optional(),
  /** Approving needs a change reference, like a ticket number. Nothing calls a ticketing system. */
  requireChangeRef: z.boolean().optional(),
  /** A regular expression the change reference must match, like ^CHG[0-9]{7}$. */
  changeRefPattern: z
    .string()
    .min(1)
    .max(200)
    .refine((p) => {
      try {
        new RegExp(p);
        return true;
      } catch {
        return false;
      }
    }, 'is not a valid regular expression')
    .optional(),
};

const weeklyTime = z
  .string()
  .refine((t) => weeklyMinute(t) !== null, 'must be a weekday and a time, like Thu 18:00');
const calendarDate = z.string().refine(isCalendarDate, 'must be a date like 2026-12-28');

/** A time when writes in an environment are refused unless an approver overrides it. */
const freezeSchema = z
  .strictObject({
    name: z.string().min(1).max(60),
    timezone: z.string().refine(isTimeZone, 'must be a time zone like Asia/Amman or UTC'),
    weekly: z.strictObject({ from: weeklyTime, to: weeklyTime }).optional(),
    dates: z.strictObject({ from: calendarDate, to: calendarDate }).optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.weekly === undefined) === (f.dates === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'needs either weekly or dates, not both' });
    }
    if (f.dates && f.dates.from > f.dates.to) {
      ctx.addIssue({ code: 'custom', path: ['dates'], message: 'from must not be after to' });
    }
  });

const namespaceName = z
  .string()
  .regex(
    /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/,
    'must be a Kubernetes namespace: lowercase letters, digits, and hyphens',
  );
const repoName = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/,
    'must be a repository like owner/repo, or a GitLab project like group/project',
  );

/** A named group of namespaces and repos with its own approval rules. */
const environmentSchema = z
  .strictObject({
    name: z
      .string()
      .regex(
        /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/,
        'must be lowercase letters, digits, and hyphens, at most 32 characters',
      ),
    /** Production environments get the profile's stricter defaults. */
    production: z.boolean().default(false),
    namespaces: z.array(namespaceName).default([]),
    repos: z.array(repoName).default([]),
    /** Who approves changes here; left out, the default approvers. */
    approvers: z.array(approver).min(1, 'needs at least one approver').optional(),
    approvals: z
      .strictObject({ ...approvalRules, expiresAfterMinutes: z.int().min(1).max(1440).optional() })
      .prefault({}),
    /** Freeze windows: writes here need an approver's override, with a reason. */
    freezes: z.array(freezeSchema).max(20).default([]),
    /** A name from spec.models: data from this environment goes only to that model (M13). */
    model: z
      .string()
      .regex(/^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/, 'must be a name from spec.models')
      .optional(),
  })
  .meta({ description: 'Namespaces and repositories with their own approval rules.' });
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export const policySchema = z
  .strictObject({
    approvals: z
      .strictObject({
        required: z
          .literal(true, {
            error:
              'approvals cannot be turned off in kodra.io/v1alpha1. Every write needs a human approval.',
          })
          .default(true),
        approvers: z.array(approver).min(1, 'needs at least one approver'),
        expiresAfterMinutes: z.int().min(1).max(1440).default(15),
        ...approvalRules,
      })
      .meta({ description: 'Who approves write actions, and how long a request stays valid.' }),
    destructiveActions: z
      .enum(['deny', 'require-approval'], {
        error: 'must be deny or require-approval',
      })
      .default('deny'),
  })
  .meta({ description: 'Approval and safety policy.' });

/** The agent's own metrics (M14), in the Prometheus format on their own port. */
const metricsSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    port: z.int().min(1024).max(65535).default(9464),
  })
  .prefault({})
  .meta({
    description: "The agent's own Prometheus metrics: counts and durations, never content.",
  });

/** OpenTelemetry traces (M14), off by default: ids, names, and durations only, never content. */
const tracingSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** An OTLP/HTTP traces endpoint, like http://otel-collector.monitoring:4318/v1/traces. */
    endpoint: httpUrl.optional(),
  })
  .prefault({})
  .meta({ description: 'OpenTelemetry traces of turns, model calls, and tool calls.' });

const auditSchema = z
  .strictObject({
    path: absolutePath.default(DEFAULT_AUDIT_PATH),
    /** Also write each record, already redacted, as a JSON line to stdout for a log collector. */
    stdout: z.boolean().default(false),
  })
  .prefault({});
const telemetrySchema = z.strictObject({ enabled: z.boolean().default(false) }).prefault({});

/** Alert investigations (M5): limits on cost and noise. */
const monitoringSchema = z
  .strictObject({
    maxConcurrent: z.int().min(1).max(10).default(2),
    maxPerHour: z.int().min(1).max(1000).default(10),
    /** Minutes before the same alert is investigated again after it fires again. */
    cooldownMinutes: z.int().min(1).max(1440).default(60),
  })
  .prefault({})
  .meta({ description: 'Limits for alert investigations.' });

/** When the read-only checks run and post a digest (M27). */
const checkScheduleSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/,
      'must be lowercase letters, digits, and hyphens, at most 32 characters',
    ),
  at: z.string().refine((t) => minuteOfDay(t) !== null, 'must be a 24-hour time like 08:30'),
  days: z
    .array(z.enum(SCHEDULE_DAYS, { error: 'must be sun, mon, tue, wed, thu, fri, or sat' }))
    .min(1)
    .default([...SCHEDULE_DAYS]),
  timezone: z.string().refine(isTimeZone, 'must be a time zone like Asia/Amman or UTC'),
});

const checksSchema = z
  .strictObject({
    schedules: z.array(checkScheduleSchema).max(10).default([]),
    /** Post nothing when every check is clean. */
    quietWhenClean: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    const names = c.schedules.map((s) => s.name);
    names.forEach((name, i) => {
      if (names.indexOf(name) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['schedules', i, 'name'],
          message: `${name} is used twice`,
        });
      }
    });
  })
  .prefault({})
  .meta({
    description:
      'Scheduled read-only checks: a digest of what is broken, posted to Slack and the console.',
  });

/** Per-question limits on the agent loop: a guard on cost and runaway tool use. */
const limitsSchema = z
  .strictObject({
    /** Model calls per question. */
    maxSteps: z.int().min(1).max(50).default(12),
    /**
     * Tokens per question, weighted by price: cached input counts a tenth, cache writes
     * 1.25 times, so the budget tracks what a question costs rather than raw tokens.
     */
    tokenBudget: z.int().min(10_000).max(5_000_000).default(200_000),
    timeoutMinutes: z.int().min(1).max(60).default(5),
    /**
     * Estimated spend per calendar month (UTC), in US dollars, from the model's prices. When it
     * is used up, new questions are refused; alert investigations keep running. Off when unset.
     */
    monthlyBudgetUsd: z.number().positive().max(1_000_000).optional(),
    /**
     * Approved writes per hour, across every connector and conversation (M29). Past it, writes
     * are refused until the hour has room again, so a loop cannot change things on repeat.
     */
    maxWritesPerHour: z.int().min(1).max(1000).default(10),
  })
  .prefault({})
  .meta({ description: 'Limits for each question the agent answers, and a monthly budget.' });

/** The web console the agent serves (M8): status, chat, and approvals. */
/**
 * Proxies and private CAs (PLAN-v0.2 M12). The proxy URLs are secret references, because a
 * proxy URL can hold a user name and password; the agent registers them with the redactor.
 */
const networkSchema = z
  .strictObject({
    proxy: z
      .strictObject({
        /** For HTTPS requests, like ${env:HTTPS_PROXY}. */
        https: secretRefSchema.optional(),
        /** For plain HTTP requests, like ${env:HTTP_PROXY}. */
        http: secretRefSchema.optional(),
        /** Hosts that skip the proxy, comma-separated, like localhost,.svc,.cluster.local. */
        noProxy: z.string().max(4000).optional(),
      })
      .optional(),
    /** A PEM file of extra CA certificates (a TLS-inspecting proxy, an internal CA). */
    caBundleFile: absolutePath.optional(),
  })
  .prefault({})
  .meta({ description: 'Proxy and CA certificates for every outbound connection.' });

/** Customer data the redactor masks besides secrets (M13); the profile picks the default. */
export const DETECTORS = ['cards', 'ibans', 'emails', 'phones'] as const;
export type Detector = (typeof DETECTORS)[number];

const dataProtectionSchema = z
  .strictObject({
    redact: z
      .array(z.enum(DETECTORS, { error: 'must be cards, ibans, emails, or phones' }))
      .optional(),
    patterns: z
      .array(
        z.strictObject({
          name: z
            .string()
            .regex(
              /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/,
              'must be lowercase letters, digits, and hyphens',
            ),
          regex: z
            .string()
            .min(1)
            .max(500)
            .refine((p) => {
              try {
                return !new RegExp(p).test('');
              } catch {
                return false;
              }
            }, 'must be a valid regular expression that does not match empty text'),
        }),
      )
      .max(20)
      .default([]),
  })
  .prefault({})
  .meta({ description: 'Customer data masked before anything leaves the agent.' });

const registryHost = z
  .string()
  .regex(/^[a-z0-9.-]+(:\d+)?$/, 'must be a registry host, like docker.io or gcr.io');
const mirrorPath = z
  .string()
  .regex(
    /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/,
    'must be a registry and path, like harbor.example.com/dockerhub-proxy',
  );

/** The ship flow (M6): where generated Dockerfiles and CI pull their base images from. */
const shipSchema = z
  .strictObject({
    /** Base images from a registry come from its mirror instead, keeping the pinned tag or digest. */
    baseImageMirrors: z.record(registryHost, mirrorPath).default({}),
  })
  .prefault({})
  .meta({ description: 'Settings for the ship flow.' });

const consoleSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    port: z.int().min(1024).max(65535).default(8081),
    /** Chat with the agent in the browser. Changes still need an approver. */
    chat: z.boolean().default(true),
    /** Overrides the model's list prices for estimated cost, in US dollars per million tokens. */
    pricing: modelPrice.optional(),
  })
  .prefault({})
  .meta({ description: 'The web console: status, activity, usage, chat, and approvals.' });

function fieldSchema(field: ConfigField): z.ZodType {
  const description = field.description;
  switch (field.kind) {
    case 'string': {
      let s = z.string().min(1);
      if (field.pattern) {
        s = s.regex(new RegExp(field.pattern), field.patternHint ?? 'has the wrong format');
      }
      const out = field.default !== undefined ? s.default(field.default) : s;
      return out.meta({ description });
    }
    case 'url': {
      const out = field.default !== undefined ? httpUrl.default(field.default) : httpUrl;
      return out.meta({ description });
    }
    case 'string-list': {
      let item = z.string().min(1);
      if (field.pattern) {
        item = item.regex(new RegExp(field.pattern), field.patternHint ?? 'has the wrong format');
      }
      return z.array(item).min(1, 'needs at least one entry').meta({ description });
    }
    case 'integer': {
      const n = z.int().min(field.min).max(field.max);
      const out = field.default !== undefined ? n.default(field.default) : n;
      return out.meta({ description });
    }
    case 'entries':
      return entriesSchema(field);
  }
}

function optionalUnless<T extends z.ZodType>(schema: T, required: boolean) {
  return required ? schema : schema.optional();
}

function connectorEntrySchema(manifest: Manifest) {
  const configShape: Record<string, z.ZodType> = {};
  for (const field of manifest.configFields) {
    const required = field.required && !('default' in field && field.default !== undefined);
    configShape[field.key] = optionalUnless(fieldSchema(field), required);
  }
  const secretsShape: Record<string, z.ZodType> = {};
  for (const secret of manifest.secrets) {
    secretsShape[secret.key] = optionalUnless(
      secretRefSchema.meta({
        description: `${secret.description} Usually \${env:${secret.envVar}}.`,
      }),
      secret.required,
    );
  }

  const shape: Record<string, z.ZodType> = { enabled: z.boolean() };
  if (manifest.accessLevels.length > 0) {
    shape['access'] = z
      .enum(manifest.accessLevels as [string, ...string[]], {
        error: `must be ${manifest.accessLevels.join(' or ')}`,
      })
      .default('read-only');
  }
  const anyConfigRequired = Object.values(configShape).some((s) => !s.safeParse(undefined).success);
  const anySecretRequired = manifest.secrets.some((s) => s.required);
  if (manifest.configFields.length > 0) {
    shape['config'] = optionalUnless(unknownKeys(configShape, 'config field'), anyConfigRequired);
  }
  if (manifest.secrets.length > 0) {
    shape['secrets'] = optionalUnless(unknownKeys(secretsShape, 'secret'), anySecretRequired);
  }
  if (manifest.credentialScope) {
    shape['allowBroadCredentials'] = z.boolean().optional().meta({
      description:
        'Keep a credential that has more access than the agent needs (like cluster-admin). Refused by default.',
    });
  }
  return unknownKeys(shape, 'key').meta({
    title: manifest.displayName,
    description: manifest.description,
  });
}

/** A strict object whose unknown-key error names what was expected. */
function unknownKeys<T extends z.ZodRawShape>(shape: T, noun: string) {
  const known = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `unknown ${noun}${issue.keys.length > 1 ? 's' : ''} ${issue.keys.join(', ')}. ` +
          `Allowed: ${known.join(', ') || 'none'}.`
        : undefined,
  });
}

/**
 * Builds the full kodra-agent.yaml schema from the connector manifests, so each connector's
 * config and secrets are validated against its own manifest.
 */
export function buildAgentConfigSchema(connectors: readonly Manifest[]) {
  const connectorShape: Record<string, z.ZodType> = {};
  for (const manifest of connectors) {
    connectorShape[manifest.id] = connectorEntrySchema(manifest).optional();
  }
  const known = connectors.filter(isUsable).map((c) => c.id);

  const connectorsSchema = z.strictObject(connectorShape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `unknown connector ${issue.keys.join(', ')}. Available: ${known.join(', ')}.`
        : undefined,
  });

  return z
    .strictObject({
      apiVersion: z.literal(SCHEMA_API_VERSION, {
        error: (issue) => apiVersionProblem(issue.input) ?? undefined,
      }),
      kind: z.literal('Agent', { error: 'kind must be Agent' }),
      metadata: z.strictObject({ name: agentName }),
      spec: z.strictObject({
        /** Defaults for a kind of organization: starter, team, or strict. */
        profile: z.enum(PROFILES, { error: 'must be starter, team, or strict' }).default('starter'),
        target: z.enum(['compose', 'kubernetes'], { error: 'must be compose or kubernetes' }),
        model: modelSchema,
        connectors: connectorsSchema.prefault({}),
        policy: policySchema,
        environments: z.array(environmentSchema).default([]),
        audit: auditSchema,
        telemetry: telemetrySchema,
        monitoring: monitoringSchema,
        checks: checksSchema,
        limits: limitsSchema,
        console: consoleSchema,
        network: networkSchema,
        dataProtection: dataProtectionSchema,
        metrics: metricsSchema,
        tracing: tracingSchema,
        /** Named models besides spec.model, for environments that pin one (M13). */
        models: z
          .record(
            z
              .string()
              .regex(
                /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/,
                'must be lowercase letters, digits, and hyphens',
              ),
            modelSchema,
          )
          .default({}),
        ship: shipSchema,
      }),
    })
    .superRefine((config, ctx) => {
      const entries = config.spec.connectors as Record<string, { enabled: boolean } | undefined>;
      const enabled = Object.entries(entries)
        .filter(([, entry]) => entry?.enabled === true)
        .map(([id]) => id);

      for (const id of enabled) {
        const manifest = connectors.find((c) => c.id === id);
        if (manifest?.status === 'coming-soon') {
          ctx.addIssue({
            code: 'custom',
            path: ['spec', 'connectors', id, 'enabled'],
            message: `${manifest.displayName} is coming soon and cannot be enabled yet.`,
          });
        }
      }
      for (const issue of checkDependencies(connectors, enabled)) {
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'connectors', issue.connector, 'enabled'],
          message: issue.message,
        });
      }
      const approvers = [
        ...config.spec.policy.approvals.approvers,
        ...config.spec.environments.flatMap((env) => env.approvers ?? []),
      ];
      if (!config.spec.console.enabled && approvers.some(isConsoleApprover)) {
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'console', 'enabled'],
          message: 'console approvers need the console: set spec.console.enabled to true.',
        });
      }
      if (config.spec.tracing.enabled && !config.spec.tracing.endpoint) {
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'tracing', 'endpoint'],
          message:
            'tracing needs an OTLP/HTTP endpoint, like http://otel-collector:4318/v1/traces.',
        });
      }
      config.spec.environments.forEach((env, i) => {
        if (env.model && !(env.model in config.spec.models)) {
          ctx.addIssue({
            code: 'custom',
            path: ['spec', 'environments', i, 'model'],
            message: `${env.model} is not in spec.models. Name a model defined there.`,
          });
        }
      });
      for (const problem of policyProblems(config.spec)) {
        ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message });
      }
    });
}

export type AgentConfigSchema = ReturnType<typeof buildAgentConfigSchema>;

export const JSON_SCHEMA_ID =
  'https://raw.githubusercontent.com/kodra-io/kodra-agent/main/schema/kodra-agent.schema.json';

/**
 * JSON Schema (draft 2020-12) for editors. It describes the input shape, so fields with
 * defaults are optional. Cross-field rules (dependencies, coming-soon) are not expressible
 * here and are checked by the agent and the configurator.
 */
export function toAgentJsonSchema(schema: AgentConfigSchema): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' });
  return {
    $schema: json.$schema,
    $id: JSON_SCHEMA_ID,
    title: 'kodra-agent.yaml',
    description: `Kodra AI Agent configuration, ${SCHEMA_API_VERSION}.`,
    ...Object.fromEntries(Object.entries(json).filter(([key]) => key !== '$schema')),
  };
}

/** Parsed config. Connector entries are typed loosely because they come from manifests. */
export interface AgentConfig {
  apiVersion: typeof SCHEMA_API_VERSION;
  kind: 'Agent';
  metadata: { name: string };
  spec: {
    profile: Profile;
    target: 'compose' | 'kubernetes';
    model: ModelConfig;
    connectors: Record<string, ConnectorEntry | undefined>;
    policy: z.infer<typeof policySchema>;
    environments: EnvironmentConfig[];
    audit: { path: string; stdout: boolean };
    metrics: { enabled: boolean; port: number };
    tracing: { enabled: boolean; endpoint?: string | undefined };
    telemetry: { enabled: boolean };
    monitoring: { maxConcurrent: number; maxPerHour: number; cooldownMinutes: number };
    checks: {
      schedules: { name: string; at: string; days: ScheduleDay[]; timezone: string }[];
      quietWhenClean: boolean;
    };
    limits: {
      maxSteps: number;
      tokenBudget: number;
      timeoutMinutes: number;
      monthlyBudgetUsd?: number | undefined;
      maxWritesPerHour: number;
    };
    dataProtection: {
      redact?: Detector[] | undefined;
      patterns: { name: string; regex: string }[];
    };
    models: Record<string, ModelConfig>;
    network: {
      proxy?:
        | { https?: string | undefined; http?: string | undefined; noProxy?: string | undefined }
        | undefined;
      caBundleFile?: string | undefined;
    };
    ship: { baseImageMirrors: Record<string, string> };
    console: {
      enabled: boolean;
      port: number;
      chat: boolean;
      pricing?: ModelPrice | undefined;
    };
  };
}

export interface ConnectorEntry {
  enabled: boolean;
  access?: 'read-only' | 'read-write-approved';
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  /** Keeps a credential broader than the agent needs (M29); only with `credentialScope`. */
  allowBroadCredentials?: boolean;
}
