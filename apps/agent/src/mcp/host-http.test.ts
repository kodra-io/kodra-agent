import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConnector } from '@kodra-agent/connectors';
import { resolveVariant } from '@kodra-agent/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Component } from '../config.ts';
import { jsonLogger } from '../io.ts';
import { Redactor } from '../redactor.ts';
import { ConnectorHost, type ConnectorInput } from './host.ts';

/**
 * A remote MCP server like GitLab's built-in one or the Jenkins plugin: Streamable HTTP at
 * one path, stateless, recording the headers of each request.
 */
async function remoteServer(path: string, tools: readonly string[], status = 200) {
  const seen: IncomingHttpHeaders[] = [];
  const http: Server = createServer((req, res) => {
    seen.push(req.headers);
    if (status !== 200 || req.url !== path) {
      res.writeHead(status === 200 ? 404 : status).end('no');
      return;
    }
    const server = new McpServer({ name: 'remote', version: '1.0.0' });
    for (const name of tools) {
      server.registerTool(
        name,
        { description: name, inputSchema: { project_id: z.string().optional() } },
        (args) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }] }),
      );
    }
    const transport = // No session id generator: stateless, like the real servers.
      new StreamableHTTPServerTransport({});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport as Parameters<typeof server.connect>[0])
      .then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  servers.push(http);
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

const servers: Server[] = [];
let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  for (const s of servers.splice(0)) s.close();
});

function input(
  id: string,
  settings: Record<string, unknown>,
  secrets: Record<string, string>,
  shared: Pick<ConnectorInput, 'sharedSettings' | 'sharedSecrets'> = {},
): ConnectorInput {
  const listed = getConnector(id);
  if (!listed) throw new Error(id);
  const manifest = resolveVariant(listed, settings, shared.sharedSettings);
  const component: Component = {
    id,
    displayName: manifest.displayName,
    manifest,
    settings,
    secrets: [],
  };
  return { component, access: 'read-write-approved', secrets, ...shared };
}

async function start(inputs: ConnectorInput[], redactor = new Redactor()) {
  host = await ConnectorHost.start(inputs, {
    redactor,
    log: jsonLogger(() => undefined, redactor),
    env: {},
  });
  return host;
}

describe('remote MCP servers (B4)', () => {
  it("talks to GitLab's built-in server with the token as a Bearer header, and only its toolsets", async () => {
    const token = 'glpat-remote-secret-0123456789'; // gitleaks:allow
    const gitlab = await remoteServer('/api/v4/mcp', [
      'list_branches',
      'add_branch',
      'accept_merge_request',
      'brand_new_tool',
    ]);
    const redactor = new Redactor();
    const h = await start(
      [input('gitlab', { url: `${gitlab.url}/`, projects: ['acme/api'] }, { token })],
      redactor,
    );
    expect(h.failures()).toEqual([]);
    // Classified tools only: merging is hidden, and a tool the manifest does not know is not shown.
    expect(
      h
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['gitlab__add_branch', 'gitlab__list_branches']);
    expect(gitlab.seen[0]?.authorization).toBe(`Bearer ${token}`);
    expect(gitlab.seen[0]?.['x-gitlab-enabled-mcp-server-toolsets']).toBe(
      'core,merge_requests,work_items,repository',
    );
    // The header, as sent, is a secret like the token.
    expect(redactor.redact(`header Bearer ${token}`)).not.toContain(token);
    const result = await h.call('gitlab__list_branches', { project_id: 'acme/api' });
    expect(JSON.parse(result.text)).toEqual({
      name: 'list_branches',
      args: { project_id: 'acme/api' },
    });
  });

  it("GitLab CI uses the GitLab connector's address and token, with the ci toolset", async () => {
    const token = 'glpat-shared-secret-0123456789'; // gitleaks:allow
    const gitlab = await remoteServer('/api/v4/mcp', ['list_pipelines', 'save_pipeline']);
    const h = await start([
      input(
        'gitlab-ci',
        {},
        {},
        {
          sharedSettings: { gitlab: { url: gitlab.url, projects: ['acme/api'] } },
          sharedSecrets: { gitlab: { token } },
        },
      ),
    ]);
    expect(
      h
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['gitlab-ci__list_pipelines', 'gitlab-ci__save_pipeline']);
    expect(gitlab.seen[0]?.authorization).toBe(`Bearer ${token}`);
    expect(gitlab.seen[0]?.['x-gitlab-enabled-mcp-server-toolsets']).toBe('ci');
  });

  it('talks to the Jenkins plugin with Basic auth from the user and the API token', async () => {
    const token = 'jenkins-api-token-0123456789';
    const jenkins = await remoteServer('/mcp-server/mcp', ['getJob', 'replayBuild']);
    const redactor = new Redactor();
    const h = await start(
      [input('jenkins', { url: jenkins.url, username: 'kodra', jobs: ['team-a'] }, { token })],
      redactor,
    );
    expect(h.tools().map((t) => t.name)).toEqual(['jenkins__getJob']);
    const encoded = Buffer.from(`kodra:${token}`).toString('base64');
    expect(jenkins.seen[0]?.authorization).toBe(`Basic ${encoded}`);
    // The encoded credentials are as secret as the token itself.
    expect(redactor.redact(`sent ${encoded}`)).not.toContain(encoded);
  });

  it('reports a server that refuses the token, without the token', async () => {
    const token = 'glpat-refused-secret-0123456789'; // gitleaks:allow
    const gitlab = await remoteServer('/api/v4/mcp', [], 401);
    const redactor = new Redactor();
    redactor.add(token);
    const h = await start(
      [input('gitlab', { url: gitlab.url, projects: ['acme/api'] }, { token })],
      redactor,
    );
    expect(h.tools()).toEqual([]);
    const [failure] = h.failures();
    expect(failure?.connector).toBe('gitlab');
    expect(failure?.reason).toContain(
      `could not reach the GitLab MCP server at ${gitlab.url}/api/v4/mcp`,
    );
    expect(failure?.reason).not.toContain(token);
  });

  it('runs the community server instead when the settings pick it', () => {
    const listed = getConnector('gitlab');
    if (!listed) throw new Error('gitlab');
    const community = resolveVariant(listed, { server: 'community' });
    expect(community.runtime).toMatchObject({ type: 'mcp-stdio' });
    expect(community.tools['create_merge_request']).toBe('write');
    expect(community.tools['add_branch']).toBeUndefined();
    // GitLab CI follows the GitLab connector's setting.
    const ci = getConnector('gitlab-ci');
    if (!ci) throw new Error('gitlab-ci');
    expect(resolveVariant(ci, {}, { gitlab: { server: 'community' } }).runtime).toMatchObject({
      type: 'mcp-stdio',
    });
    expect(resolveVariant(ci, {}, { gitlab: { server: 'builtin' } }).runtime).toMatchObject({
      type: 'mcp-http',
    });
  });
});
