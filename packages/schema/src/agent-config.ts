import { z } from 'zod';
import { checkDependencies } from './dependencies.ts';
import type { ConfigField, Manifest } from './manifest.ts';
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

// Slack handles like @omar, or Slack user ids like U0123ABCD.
const approver = z
  .string()
  .regex(
    /^(@[A-Za-z0-9][A-Za-z0-9._-]{0,79}|[UW][A-Z0-9]{2,})$/,
    'must be a Slack handle like @omar or a Slack user id like U0123ABCD',
  );

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
      })
      .meta({ description: 'Who approves write actions, and how long a request stays valid.' }),
    destructiveActions: z
      .enum(['deny', 'require-approval'], {
        error: 'must be deny or require-approval',
      })
      .default('deny'),
  })
  .meta({ description: 'Approval and safety policy.' });

const auditSchema = z.strictObject({ path: absolutePath.default(DEFAULT_AUDIT_PATH) }).prefault({});
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

function fieldSchema(field: ConfigField): z.ZodType {
  const description = field.description.en;
  switch (field.kind) {
    case 'string': {
      let s = z.string().min(1);
      if (field.pattern) {
        s = s.regex(new RegExp(field.pattern), field.patternHint?.en ?? 'has the wrong format');
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
        item = item.regex(
          new RegExp(field.pattern),
          field.patternHint?.en ?? 'has the wrong format',
        );
      }
      return z.array(item).min(1, 'needs at least one entry').meta({ description });
    }
    case 'integer': {
      const n = z.int().min(field.min).max(field.max);
      const out = field.default !== undefined ? n.default(field.default) : n;
      return out.meta({ description });
    }
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
        description: `${secret.description.en} Usually \${env:${secret.envVar}}.`,
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
  return unknownKeys(shape, 'key').meta({
    title: manifest.displayName,
    description: manifest.description.en,
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
  const known = connectors.filter((c) => c.status === 'available').map((c) => c.id);

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
        target: z.enum(['compose', 'kubernetes'], { error: 'must be compose or kubernetes' }),
        model: modelSchema,
        connectors: connectorsSchema.prefault({}),
        policy: policySchema,
        audit: auditSchema,
        telemetry: telemetrySchema,
        monitoring: monitoringSchema,
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
          message: issue.message.en,
        });
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
    target: 'compose' | 'kubernetes';
    model: ModelConfig;
    connectors: Record<string, ConnectorEntry | undefined>;
    policy: z.infer<typeof policySchema>;
    audit: { path: string };
    telemetry: { enabled: boolean };
    monitoring: { maxConcurrent: number; maxPerHour: number; cooldownMinutes: number };
  };
}

export interface ConnectorEntry {
  enabled: boolean;
  access?: 'read-only' | 'read-write-approved';
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}
