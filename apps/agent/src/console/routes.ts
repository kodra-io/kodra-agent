import type { Runtime } from '../runtime.ts';
import {
  activity,
  approvals,
  connectorViews,
  readAudit,
  status,
  usage,
  type InvestigationLog,
} from './data.ts';
import type { ApiRoute } from './server.ts';

export interface ConsoleInfo {
  version: string;
  startedAt: Date;
  slack: boolean;
  monitoring: boolean;
}

/** The console's read-only API, one route per page. */
export function consoleRoutes(
  runtime: Runtime,
  info: ConsoleInfo,
  investigations: InvestigationLog,
): Record<string, ApiRoute> {
  const auditPath = runtime.config.spec.audit.path;
  const model = `${runtime.config.spec.model.provider}/${runtime.config.spec.model.name}`;
  const text = (q: URLSearchParams, key: string) => q.get(key) ?? undefined;
  return {
    status: () => status(runtime, info),
    connectors: () => connectorViews(runtime),
    activity: async (q) => {
      const limit = Number(q.get('limit') ?? '100');
      return activity(await readAudit(auditPath), {
        event: text(q, 'event'),
        decision: text(q, 'decision'),
        connector: text(q, 'connector'),
        actor: text(q, 'actor'),
        q: text(q, 'q'),
        before: text(q, 'before'),
        limit: Number.isFinite(limit) ? limit : undefined,
      });
    },
    usage: async () =>
      usage(await readAudit(auditPath), model, runtime.config.spec.console.pricing),
    approvals: async () => approvals(await readAudit(auditPath)),
    investigations: () => investigations.list(),
  };
}
