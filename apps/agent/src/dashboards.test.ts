import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AgentMetrics } from './metrics.ts';

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** Every metric family the agent exposes, from a render with every optional family present. */
function families(): Set<string> {
  const m = new AgentMetrics({ version: '0.0.0', models: ['a/b'], cost: () => 1 });
  m.observe({
    ts: new Date().toISOString(),
    event: 'model.call',
    model: 'a/b',
    usage: { output: 1 },
  });
  m.setBudget({ remaining: 1, limit: 2 });
  return new Set([...m.render().matchAll(/^# TYPE (\w+) /gm)].map((match) => match[1] ?? ''));
}

const used = (expr: string) => [...expr.matchAll(/\bkodra_agent_\w+/g)].map((m) => m[0]);

describe('the Grafana dashboard and the alert rules', () => {
  const known = families();

  it('query only metrics the agent exposes', () => {
    const dashboard = JSON.parse(readFileSync(root('dashboards/kodra-agent.json'), 'utf8')) as {
      panels: { title: string; targets: { expr: string }[] }[];
      templating: { list: { query?: unknown }[] };
    };
    const exprs = [
      ...dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)),
      ...dashboard.templating.list.map((v) => (typeof v.query === 'string' ? v.query : '')),
    ];
    const rules = (
      parse(readFileSync(root('charts/kodra-agent/files/alerts.yaml'), 'utf8')) as {
        groups: { rules: { expr: string }[] }[];
      }
    ).groups.flatMap((g) => g.rules.map((r) => r.expr));
    const names = [...exprs, ...rules].flatMap(used);
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((n) => !known.has(n))).toEqual([]);
  });

  it('use every metric the agent exposes', () => {
    const text = [
      readFileSync(root('dashboards/kodra-agent.json'), 'utf8'),
      readFileSync(root('charts/kodra-agent/files/alerts.yaml'), 'utf8'),
    ].join('\n');
    expect([...known].filter((n) => !text.includes(n))).toEqual([]);
  });
});
