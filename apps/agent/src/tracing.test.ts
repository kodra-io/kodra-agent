import { describe, expect, it } from 'vitest';
import { fakeServer } from './test-helpers.ts';
import { startTracer } from './tracing.ts';

describe('startTracer', () => {
  it('sends spans to the OTLP/HTTP endpoint on shutdown', async () => {
    let body = '';
    const collector = await fakeServer({
      'POST /v1/traces': (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          body = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      },
    });
    try {
      const tracer = await startTracer(
        { enabled: true, endpoint: `${collector.url}/v1/traces` },
        '0.3.0',
      );
      const turn = tracer.start('kodra.turn', { 'kodra.task_kind': 'chat' });
      turn.child('kodra.tool', { 'kodra.tool': 'pods_log' }).end();
      turn.end();
      await tracer.shutdown();
      expect(collector.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /v1/traces']);
      // JSON or protobuf, the span and service names are in the payload as text.
      expect(body).toContain('kodra.turn');
      expect(body).toContain('kodra.tool');
      expect(body).toContain('kodra-agent');
    } finally {
      await collector.close();
    }
  });
});
