import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnector } from '@kodra-agent/connectors';
import type { AccessLevel } from '@kodra-agent/schema';
import { AuditLog } from '../audit.ts';
import type { Component } from '../config.ts';
import { jsonLogger } from '../io.ts';
import { Redactor } from '../redactor.ts';
import { ConnectorHost, type ConnectorInput, type HostOptions } from './host.ts';

/**
 * Dummy settings and credentials that let each real server start and list its tools.
 * No API calls are made. Kubernetes is covered by the kind test.
 */
export const DUMMY_CASES: {
  id: string;
  access: AccessLevel;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}[] = [
  {
    id: 'github',
    access: 'read-write-approved',
    settings: { repos: ['acme/api'] },
    secrets: { token: 'ghp_dummy_not_used' },
  },
  { id: 'github-actions', access: 'read-write-approved', settings: {}, secrets: {} },
  {
    id: 'gitlab',
    access: 'read-write-approved',
    settings: { url: 'http://127.0.0.1:1', projects: ['acme/api'] },
    secrets: { token: 'glpat-dummy-not-used' },
  },
  { id: 'gitlab-ci', access: 'read-write-approved', settings: {}, secrets: {} },
  {
    id: 'grafana',
    access: 'read-only',
    settings: { url: 'http://127.0.0.1:1' },
    secrets: { serviceAccountToken: 'dummy' },
  },
  { id: 'prometheus', access: 'read-only', settings: { url: 'http://127.0.0.1:1' }, secrets: {} },
  {
    id: 'aws',
    access: 'read-only',
    settings: { region: 'eu-central-1' },
    secrets: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'dummy-not-used' },
  },
];

/** Tools that must never reach the model, under any connector. */
export const NEVER_EXPOSED = [
  'merge_pull_request',
  'pull_request_review_write',
  'merge_merge_request',
  'approve_merge_request',
  'update_default_branch',
  'execute_graphql',
  'get_pipeline_variables',
  'get_pipeline_schedule_variable',
  'get_pod_logs',
  'configuration_view',
];

export interface ServerCheck {
  id: string;
  tools: number;
  /** Tools the server offers that the manifest does not classify (hidden, but a sign of drift). */
  unclassified: string[];
  /** NEVER_EXPOSED tools that reached the model's tool list. */
  exposed: string[];
}

function component(id: string, settings: Record<string, unknown>): Component {
  const manifest = getConnector(id);
  if (!manifest) throw new Error(`unknown connector ${id}`);
  return { id, displayName: manifest.displayName, manifest, settings, secrets: [] };
}

/** Starts one connector's real server(s) through the host and reports what it offers. */
export async function checkServer(
  c: (typeof DUMMY_CASES)[number],
  opts: { env: Readonly<Record<string, string | undefined>>; launcher?: HostOptions['launcher'] },
): Promise<ServerCheck> {
  const redactor = new Redactor();
  const dir = await mkdtemp(join(tmpdir(), 'kodra-check-'));
  const auditPath = join(dir, 'audit.jsonl');
  const input: ConnectorInput = {
    component: component(c.id, c.settings),
    access: c.access,
    secrets: c.secrets,
  };
  const parent = DUMMY_CASES.find(
    (p) => p.id === (c.id === 'github-actions' ? 'github' : c.id === 'gitlab-ci' ? 'gitlab' : ''),
  );
  if (parent) {
    input.sharedSecrets = { [parent.id]: parent.secrets };
    input.sharedSettings = { [parent.id]: parent.settings };
  }
  const host = await ConnectorHost.start([input], {
    redactor,
    log: jsonLogger(() => undefined, redactor),
    audit: new AuditLog(auditPath, redactor),
    env: opts.env,
    ...(opts.launcher ? { launcher: opts.launcher } : {}),
  });
  try {
    const tools = host.tools();
    const audit = await readFile(auditPath, 'utf8').catch(() => '');
    const unclassified = audit
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tool?: string; risk?: string })
      .filter((r) => r.risk === 'unclassified')
      .map((r) => r.tool ?? '');
    return {
      id: c.id,
      tools: tools.length,
      unclassified,
      exposed: tools.filter((t) => NEVER_EXPOSED.includes(t.tool)).map((t) => t.tool),
    };
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
