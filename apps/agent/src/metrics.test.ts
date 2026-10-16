import { describe, expect, it } from 'vitest';
import { AgentMetrics } from './metrics.ts';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function metrics() {
  return new AgentMetrics({
    version: '0.3.0',
    models: ['anthropic/claude-sonnet-5-5'],
    cost: (_model, usage) => (usage['output'] ?? 0) / 1000,
  });
}

describe('AgentMetrics', () => {
  it('renders every family in the Prometheus text format', () => {
    const text = metrics().render(T0);
    expect(text.endsWith('\n')).toBe(true);
    for (const name of [
      'kodra_agent_info',
      'kodra_agent_tool_calls_total',
      'kodra_agent_approvals_pending',
      'kodra_agent_approval_oldest_seconds',
      'kodra_agent_model_tokens_total',
      'kodra_agent_connector_up',
      'kodra_agent_errors_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('kodra_agent_info{version="0.3.0"} 1');
    // Model token series exist from the start, so rate() works on the first increase.
    expect(text).toContain(
      'kodra_agent_model_tokens_total{kind="output",model="anthropic/claude-sonnet-5-5"} 0',
    );
    // No budget configured: no budget series.
    expect(text).not.toContain('kodra_agent_budget_remaining');
  });

  it('counts tool calls, approvals, model use, investigations, and errors from audit records', () => {
    const m = metrics();
    m.observe({ ts: at(0), event: 'task.start', task: 'alert-1' });
    m.observe({
      ts: at(1),
      event: 'tool.call',
      connector: 'kubernetes',
      risk: 'read',
      decision: 'allowed',
    });
    m.observe({ ts: at(2), event: 'approval.request', detail: 'req-1; scale web' });
    m.observe({ ts: at(3), event: 'approval.request', detail: 'req-2; restart db' });
    m.observe({ ts: at(4), event: 'approval.decision', detail: 'req-1; x', decision: 'blocked' });
    m.observe({ ts: at(32), event: 'approval.decision', detail: 'req-1; x', decision: 'approved' });
    m.observe({
      ts: at(33),
      event: 'model.call',
      model: 'anthropic/claude-sonnet-5-5',
      usage: { input: 100, cacheRead: 50, cacheWrite: 0, output: 2000 },
    });
    m.observe({ ts: at(40), event: 'result', task: 'alert-1' });
    m.observe({ ts: at(41), event: 'error', task: 'alert-2' });
    m.observe({ ts: at(42), event: 'error', task: 'chat-1' });
    m.setConnectorUp('kubernetes', true);
    m.setConnectorUp('grafana', false);
    m.setBudget({ remaining: 25, limit: 100 });

    const text = m.render(T0 + 63_000);
    expect(text).toContain(
      'kodra_agent_tool_calls_total{connector="kubernetes",decision="allowed",risk="read"} 1',
    );
    expect(text).toContain('kodra_agent_approvals_pending 1');
    expect(text).toContain('kodra_agent_approval_oldest_seconds 60');
    expect(text).toContain('kodra_agent_approval_wait_seconds_sum{decision="approved"} 30');
    expect(text).toContain('kodra_agent_approval_wait_seconds_count{decision="approved"} 1');
    expect(text).toContain(
      'kodra_agent_model_tokens_total{kind="output",model="anthropic/claude-sonnet-5-5"} 2000',
    );
    expect(text).toContain(
      'kodra_agent_model_tokens_total{kind="cache_read",model="anthropic/claude-sonnet-5-5"} 50',
    );
    expect(text).toContain(
      'kodra_agent_model_cost_usd_total{model="anthropic/claude-sonnet-5-5"} 2',
    );
    expect(text).toContain('kodra_agent_investigations_total 1');
    expect(text).toContain('kodra_agent_investigation_seconds_sum 40');
    expect(text).toContain('kodra_agent_errors_total{source="investigation"} 1');
    expect(text).toContain('kodra_agent_errors_total{source="agent"} 1');
    expect(text).toContain('kodra_agent_connector_up{connector="kubernetes"} 1');
    expect(text).toContain('kodra_agent_connector_up{connector="grafana"} 0');
    expect(text).toContain('kodra_agent_budget_remaining_usd 25');
    expect(text).toContain('kodra_agent_budget_remaining_ratio 0.25');
  });

  it('never puts record content in a label: unknown values become "other"', () => {
    const m = new AgentMetrics({ version: 'v1"} 1\nevil', models: [] });
    m.observe({
      ts: at(0),
      event: 'tool.call',
      connector: 'customer-db password=hunter2',
      risk: 'yolo',
      decision: 'maybe',
    });
    m.observe({ ts: at(1), event: 'model.call', model: 'secret-model', usage: { output: 1 } });
    m.setConnectorUp('not-a-connector', true);
    const text = m.render(T0);
    expect(text).toContain('kodra_agent_info{version="other"} 1');
    expect(text).toContain(
      'kodra_agent_tool_calls_total{connector="other",decision="other",risk="other"} 1',
    );
    expect(text).toContain('kodra_agent_model_tokens_total{kind="output",model="other"} 1');
    expect(text).toContain('kodra_agent_connector_up{connector="other"} 1');
    expect(text).not.toMatch(/hunter2|secret-model|yolo|maybe|evil/);
  });
});
