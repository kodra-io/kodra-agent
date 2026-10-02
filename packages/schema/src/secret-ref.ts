import { z } from 'zod';

/**
 * Secret references point at where a secret lives. The value itself never appears in
 * kodra-agent.yaml. MVP schemes: `${env:NAME}` and `${file:/absolute/path}`.
 */
export type SecretRef = { scheme: 'env'; name: string } | { scheme: 'file'; path: string };

export type SecretRefResult = { ok: true; ref: SecretRef } | { ok: false; message: string };

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const REF_SHAPE = /^\$\{([a-z][a-z0-9-]*):(.*)\}$/;
const PLANNED_SCHEMES = new Set(['vault', 'aws-sm', 'azure-kv']);

/** Pattern exported to JSON Schema so editors flag plain values early. */
export const SECRET_REF_PATTERN = '^\\$\\{(env:[A-Z_][A-Z0-9_]*|file:/[^}]*)\\}$';

export const SECRET_REF_HINT = 'Use ${env:NAME} or ${file:/path}';

/**
 * Parses a secret reference. Error messages never include the input, because a value that
 * is not a reference may be a pasted secret.
 */
export function parseSecretRef(input: string): SecretRefResult {
  const match = REF_SHAPE.exec(input.trim());
  if (!match) {
    return {
      ok: false,
      message: `must be a secret reference, not a value. ${SECRET_REF_HINT} and keep the value in your environment.`,
    };
  }
  const scheme = match[1] ?? '';
  const target = match[2] ?? '';
  if (scheme === 'env') {
    if (!ENV_NAME.test(target)) {
      return {
        ok: false,
        message:
          'env reference needs a variable name in capitals, digits, and underscores, like ${env:GITHUB_TOKEN}.',
      };
    }
    return { ok: true, ref: { scheme: 'env', name: target } };
  }
  if (scheme === 'file') {
    if (!target.startsWith('/') || target.includes('\0')) {
      return {
        ok: false,
        message: 'file reference needs an absolute path, like ${file:/secrets/kubeconfig}.',
      };
    }
    return { ok: true, ref: { scheme: 'file', path: target } };
  }
  if (PLANNED_SCHEMES.has(scheme)) {
    return {
      ok: false,
      message: `${scheme} references are not supported yet. ${SECRET_REF_HINT}.`,
    };
  }
  return { ok: false, message: `unknown secret reference type. ${SECRET_REF_HINT}.` };
}

export function formatSecretRef(ref: SecretRef): string {
  return ref.scheme === 'env' ? `\${env:${ref.name}}` : `\${file:${ref.path}}`;
}

/** zod schema for a secret field: a string that must parse as a secret reference. */
export const secretRefSchema = z
  .string({ error: `must be a secret reference. ${SECRET_REF_HINT}.` })
  .superRefine((value, ctx) => {
    const result = parseSecretRef(value);
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.message });
  })
  .meta({ pattern: SECRET_REF_PATTERN, description: `Secret reference. ${SECRET_REF_HINT}.` });
