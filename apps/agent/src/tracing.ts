import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * OpenTelemetry traces (PLAN-v0.2 M14), off by default. Spans cover a turn, each model step,
 * and each tool call, with names, ids, durations, counts, and labels from fixed sets only:
 * never a prompt, an argument, an answer, or tool output. The SDK is imported only when
 * tracing is on, so the default costs nothing.
 */

export type SpanAttributes = Record<string, string | number | boolean>;

export interface TraceSpan {
  child(name: string, attributes?: SpanAttributes): TraceSpan;
  set(attributes: SpanAttributes): void;
  end(failed?: boolean): void;
}

export interface AgentTracer {
  start(name: string, attributes?: SpanAttributes): TraceSpan;
  /** Sends what is buffered and stops. */
  shutdown(): Promise<void>;
}

const NO_SPAN: TraceSpan = {
  child: () => NO_SPAN,
  set: () => undefined,
  end: () => undefined,
};

export const NO_TRACER: AgentTracer = {
  start: () => NO_SPAN,
  shutdown: () => Promise.resolve(),
};

/** Turn kinds by task id prefix; anything else is "other". */
const TASK_KINDS = new Set(['alert', 'slack', 'console', 'chat', 'ship', 'doctor']);

export function taskKind(task: string): string {
  const prefix = task.split('-')[0] ?? '';
  return TASK_KINDS.has(prefix) ? prefix : 'other';
}

export async function startTracer(
  settings: { enabled: boolean; endpoint?: string | undefined },
  version: string,
  /** Tests pass an in-memory exporter; otherwise OTLP/HTTP to `settings.endpoint`. */
  exporter?: SpanExporter,
): Promise<AgentTracer> {
  if (!settings.enabled) return NO_TRACER;
  const api = await import('@opentelemetry/api');
  const { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } =
    await import('@opentelemetry/sdk-trace-base');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  let processor;
  if (exporter) {
    processor = new SimpleSpanProcessor(exporter);
  } else {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    processor = new BatchSpanProcessor(
      new OTLPTraceExporter(settings.endpoint ? { url: settings.endpoint } : {}),
    );
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'kodra-agent', 'service.version': version }),
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer('kodra-agent', version);
  const wrap = (span: ReturnType<typeof tracer.startSpan>): TraceSpan => ({
    child: (name, attributes) =>
      wrap(
        tracer.startSpan(
          name,
          attributes ? { attributes } : {},
          api.trace.setSpan(api.ROOT_CONTEXT, span),
        ),
      ),
    set: (attributes) => {
      span.setAttributes(attributes);
    },
    end: (failed) => {
      if (failed) span.setStatus({ code: api.SpanStatusCode.ERROR });
      span.end();
    },
  });
  return {
    start: (name, attributes) =>
      wrap(tracer.startSpan(name, attributes ? { attributes } : {}, api.ROOT_CONTEXT)),
    shutdown: () => provider.shutdown(),
  };
}
