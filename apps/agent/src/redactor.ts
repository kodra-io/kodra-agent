/**
 * Masks secret values in any text before it leaves the process: terminal output, logs,
 * the audit log, and (from M4) everything sent to the model.
 */
export const REDACTED = '[REDACTED]';

/** Values shorter than this are not registered, so redaction cannot shred normal text. */
export const MIN_SECRET_LENGTH = 4;

interface TokenPattern {
  name: string;
  pattern: RegExp;
  /** Keeps a leading group, like "Bearer ", and masks the rest. */
  keepPrefix?: boolean;
}

/** Common credential shapes, masked even when the value was never registered. */
export const TOKEN_PATTERNS: readonly TokenPattern[] = [
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'gitlab-token', pattern: /\bgl(?:pat|dt|ptt|rt|cbt|oas)-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack-app-token', pattern: /\bxapp-[A-Za-z0-9-]{10,}/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer', pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepPrefix: true },
  {
    name: 'kubeconfig-credential',
    pattern:
      /(\b(?:client-key-data|client-certificate-data|token|password)\s*:\s*)["']?[^\s"']{8,}["']?/g,
    keepPrefix: true,
  },
];

function toBase64(value: string, url: boolean): string {
  const b64 = Buffer.from(value, 'utf8').toString(url ? 'base64url' : 'base64');
  return url ? b64 : b64.replace(/=+$/, '');
}

/** The forms a value takes when it is embedded in JSON, URLs, or base64 payloads. */
function variants(value: string): string[] {
  const forms = new Set<string>([value]);
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(encodeURIComponent(value));
  forms.add(toBase64(value, false));
  forms.add(toBase64(value, true));
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `token: abc`, `password = "abc"`, `client-key-data: …` lines inside a structured secret. */
const CREDENTIAL_FIELD =
  /^\s*[\w.-]*(?:token|password|passwd|secret|key|credential|auth|data)[\w.-]*\s*[:=]\s*["']?([^\s"']{8,})["']?\s*$/gim;

export class Redactor {
  private readonly forms = new Set<string>();
  private matcher: RegExp | null = null;

  /**
   * Registers a secret value. Every later redact() call masks it in all its forms. For
   * structured secrets like a kubeconfig, the credential fields inside are registered too,
   * so a token is masked even when it shows up on its own.
   */
  add(value: string): void {
    const trimmed = value.trim();
    const candidates = new Set([value, trimmed]);
    if (value.includes('\n')) {
      for (const match of value.matchAll(CREDENTIAL_FIELD)) {
        if (match[1]) candidates.add(match[1]);
      }
    }
    for (const candidate of candidates) {
      if (candidate.length < MIN_SECRET_LENGTH) continue;
      for (const form of variants(candidate)) this.forms.add(form);
    }
    this.matcher = null;
  }

  get size(): number {
    return this.forms.size;
  }

  redact(text: string): string {
    let out = text;
    if (this.forms.size > 0) {
      // Longest first, so a value that contains another one is masked whole.
      this.matcher ??= new RegExp(
        [...this.forms]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join('|'),
        'g',
      );
      out = out.replace(this.matcher, REDACTED);
    }
    for (const { pattern, keepPrefix } of TOKEN_PATTERNS) {
      out = out.replace(pattern, (match, prefix: unknown) =>
        keepPrefix && typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED,
      );
    }
    return out;
  }

  /** Redacts any value by serializing it first. */
  redactValue(value: unknown): string {
    if (typeof value === 'string') return this.redact(value);
    const json = JSON.stringify(value) as string | undefined;
    return this.redact(json ?? String(value));
  }
}
