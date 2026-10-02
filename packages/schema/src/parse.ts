import {
  isMap,
  isPair,
  isScalar,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from 'yaml';
import type { z } from 'zod';
import { apiVersionProblem, type AgentConfig, type AgentConfigSchema } from './agent-config.ts';

export interface ConfigIssue {
  /** Dotted path into the config, like spec.connectors.github.access. Empty for the root. */
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export type ParseResult = { ok: true; config: AgentConfig } | { ok: false; issues: ConfigIssue[] };

export const DEFAULT_FILE_NAME = 'kodra-agent.yaml';

/**
 * Parses and validates kodra-agent.yaml text. Every issue carries the line and column it
 * points at. Messages never include input values for secret fields.
 */
export function parseAgentConfig(text: string, schema: AgentConfigSchema): ParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => {
        const pos = lineCounter.linePos(error.pos[0]);
        return {
          path: '',
          message: `YAML syntax error: ${error.message.split('\n')[0] ?? 'invalid YAML'}`,
          line: pos.line,
          column: pos.col,
        };
      }),
    };
  }

  const data: unknown = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      issues: [{ path: '', message: 'must be a YAML mapping', line: 1, column: 1 }],
    };
  }

  // A wrong apiVersion makes every other error noise, so report it alone.
  const versionProblem = apiVersionProblem((data as Record<string, unknown>)['apiVersion']);
  if (versionProblem) {
    return { ok: false, issues: [locate(doc, lineCounter, ['apiVersion'], versionProblem)] };
  }

  const result = schema.safeParse(data);
  if (result.success) return { ok: true, config: result.data as AgentConfig };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => toConfigIssue(doc, lineCounter, issue)),
  };
}

function toConfigIssue(
  doc: Document,
  lineCounter: LineCounter,
  issue: z.core.$ZodIssue,
): ConfigIssue {
  const path = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
  if (issue.code === 'unrecognized_keys' && issue.keys[0] !== undefined) {
    return locate(doc, lineCounter, [...path, issue.keys[0]], issue.message, path);
  }
  if (issue.code === 'invalid_type' && path.length > 0 && !doc.hasIn(path)) {
    return locate(doc, lineCounter, path, 'is required');
  }
  return locate(doc, lineCounter, path, issue.message);
}

/** Finds the closest node for a path: the key itself when present, else the nearest parent. */
function locate(
  doc: Document,
  lineCounter: LineCounter,
  path: readonly (string | number)[],
  message: string,
  reportPath: readonly (string | number)[] = path,
): ConfigIssue {
  const dotted = reportPath.join('.');
  for (let depth = path.length; depth >= 0; depth--) {
    const offset = keyOffset(doc, path.slice(0, depth));
    if (offset !== undefined) {
      const pos = lineCounter.linePos(offset);
      return { path: dotted, message, line: pos.line, column: pos.col };
    }
  }
  return { path: dotted, message };
}

function keyOffset(doc: Document, path: readonly (string | number)[]): number | undefined {
  if (path.length === 0) return doc.contents?.range?.[0];
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  const last = path[path.length - 1];
  if (isMap(parent)) {
    const pair = parent.items.find(
      (item) => isPair(item) && isScalar(item.key) && item.key.value === last,
    );
    const key = pair?.key as Node | undefined;
    return key?.range?.[0];
  }
  const node = doc.getIn(path, true) as Node | undefined;
  return node?.range?.[0];
}

export function formatIssue(issue: ConfigIssue, fileName = DEFAULT_FILE_NAME): string {
  const where =
    issue.line !== undefined ? `${fileName}:${issue.line}:${issue.column ?? 1}` : fileName;
  return issue.path ? `${where} ${issue.path}: ${issue.message}` : `${where} ${issue.message}`;
}
