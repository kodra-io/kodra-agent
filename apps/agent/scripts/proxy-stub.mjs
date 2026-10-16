// Stand-in for every outside service in the proxy test (PLAN-v0.2 M12): Slack (Web API and
// the Socket Mode WebSocket), the model, Alertmanager, Prometheus, Grafana, a git repo, and a
// chart repo, all on one HTTPS port. It is only reachable through the proxy. Every request is
// recorded as "<host> <method> <path>" and served at GET /__seen for the test to check.
// Plain JavaScript with no dependencies, so it runs in a stock node image.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const seen = [];
const posted = [];

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const body = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => resolve(text));
  });

/** The model: a Prometheus tool call, then a Grafana one, then the answer. */
function anthropic(request) {
  const tools = (request.tools ?? []).map((t) => t.name);
  const results = (request.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result').length;
  const call = (name, input) => ({
    type: 'tool_use',
    id: `toolu_${String(results)}`,
    name,
    input,
  });
  const prometheus = tools.find((t) => t.endsWith('execute_query'));
  const grafana = tools.find((t) => t.endsWith('search_dashboards'));
  const content =
    results === 0 && prometheus
      ? [call(prometheus, { query: 'up' })]
      : results === 1 && grafana
        ? [call(grafana, { query: 'checkout' })]
        : [{ type: 'text', text: 'Proxy check: the alert is a test. All clear.' }];
  return {
    id: `msg_${String(results)}`,
    type: 'message',
    role: 'assistant',
    model: request.model ?? 'stub-model',
    content,
    stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const server = createServer(
  { key: readFileSync('/stub/key.pem'), cert: readFileSync('/stub/cert.pem') },
  async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const path = (req.url ?? '').split('?')[0];
    seen.push(`${host} ${req.method} ${path}`);
    const text = await body(req);

    if (path === '/__seen') return json(res, { seen, posted });
    if (host === 'slack.com') {
      if (path === '/api/apps.connections.open') {
        return json(res, { ok: true, url: 'wss://slack-ws.test/link' });
      }
      if (path === '/api/chat.postMessage') {
        const params = req.headers['content-type']?.includes('json')
          ? JSON.parse(text)
          : Object.fromEntries(new URLSearchParams(text));
        posted.push(String(params.text ?? ''));
        return json(res, { ok: true, channel: 'C0OPS', ts: `1700000000.${String(posted.length)}` });
      }
      return json(res, { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT', team_id: 'T0' });
    }
    if (host === 'model.test') {
      if (path === '/v1/models') return json(res, { data: [{ id: 'stub-model' }] });
      if (path === '/v1/messages') return json(res, anthropic(JSON.parse(text)));
    }
    if (host === 'alertmanager.test' && path === '/api/v2/alerts') {
      return json(res, [
        {
          labels: { alertname: 'ProxyTest', severity: 'warning', namespace: 'shop' },
          annotations: { summary: 'A test alert behind the proxy' },
          startsAt: new Date().toISOString(),
          fingerprint: 'proxy-test',
          status: { state: 'active' },
        },
      ]);
    }
    if (host === 'prometheus.test') {
      return json(res, { status: 'success', data: { resultType: 'vector', result: [] } });
    }
    if (host === 'grafana.test') return json(res, path === '/api/search' ? [] : {});
    if (host === 'git.test' && path === '/repo.git/info/refs') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`${'a'.repeat(40)}\trefs/heads/main\n`);
    }
    if (host === 'charts.test' && path === '/index.yaml') {
      res.writeHead(200, { 'content-type': 'application/x-yaml' });
      return res.end('apiVersion: v1\nentries: {}\ngenerated: "2026-10-16T00:00:00Z"\n');
    }
    json(res, { error: `no stub for ${host} ${path}` }, 404);
  },
);

// Socket Mode: a WebSocket that says hello and answers pings.
server.on('upgrade', (req, socket) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  seen.push(`${host} UPGRADE ${(req.url ?? '').split('?')[0]}`);
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const frame = (opcode, payload) => {
    const data = Buffer.from(payload);
    const head =
      data.length < 126
        ? Buffer.from([0x80 | opcode, data.length])
        : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 0xff]);
    socket.write(Buffer.concat([head, data]));
  };
  frame(
    0x1,
    JSON.stringify({
      type: 'hello',
      num_connections: 1,
      debug_info: { host: 'proxy-test', approximate_connection_time: 3600 },
      connection_info: { app_id: 'A0PROXY' },
    }),
  );
  socket.on('data', (buf) => {
    // Client frames are masked: opcode in the first byte, length and mask after it.
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      len = buf.readUInt16BE(2);
      offset = 4;
    }
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len)).map(
      (b, i) => b ^ mask[i % 4],
    );
    if (opcode === 0x9) frame(0xa, payload);
    if (opcode === 0x8) socket.end();
  });
  socket.on('error', () => undefined);
});

server.listen(443, () => console.log('stub listening on 443'));

// What the stub saw, for the test (inside the container only, with docker exec).
import { createServer as createPlainServer } from 'node:http';
createPlainServer((req, res) => json(res, { seen, posted })).listen(8099, '127.0.0.1');
