import { readFileSync } from 'node:fs';
import {
  AGENT_CHART,
  AGENT_IMAGE,
  AGENT_VERSION,
  checkDockerfile,
  emptyDraft,
  generateBundle,
  type AgentDraft,
} from '@kodra-agent/templates';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { VERSION } from './cli.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const chart = parse(read('charts/kodra-agent/Chart.yaml')) as {
  name: string;
  version: string;
  appVersion: string;
};
const chartValues = parse(read('charts/kodra-agent/values.yaml')) as Record<string, unknown>;

/** Every key path in a values object, like image.repository. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('release consistency', () => {
  it('uses one version for the CLI, the bundle, and the chart', () => {
    expect(VERSION).toBe(AGENT_VERSION);
    expect(chart.version).toBe(AGENT_VERSION);
    expect(chart.appVersion).toBe(AGENT_VERSION);
  });

  it('points the bundle at this chart and image', () => {
    expect(AGENT_CHART).toBe(`oci://ghcr.io/kodra-io/charts/${chart.name}`);
    expect((chartValues['image'] as { repository: string }).repository).toBe(AGENT_IMAGE);
  });

  it('accepts every value the bundle sets', () => {
    const draft: AgentDraft = { ...emptyDraft(), name: 'demo', target: 'kubernetes' };
    const bundleValues = parse(
      generateBundle(draft).files.find((f) => f.path === 'values.yaml')?.content ?? '',
    ) as Record<string, unknown>;
    const known = new Set(keyPaths(chartValues));
    const isKnown = (path: string) =>
      known.has(path) ||
      [...known].some((k) => k.startsWith(`${path}.`) || path.startsWith(`${k}.`));
    expect(keyPaths(bundleValues).filter((p) => !isKnown(p))).toEqual([]);
  });

  it('pins every image in the agent Dockerfile and runs as non-root', () => {
    expect(checkDockerfile(read('docker/Dockerfile'))).toEqual([]);
  });
});
