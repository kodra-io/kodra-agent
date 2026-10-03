import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit.ts';
import { jsonLogger } from '../io.ts';
import { Redactor } from '../redactor.ts';
import { fakeComponent, fakeLauncher } from '../test-fixtures/fake-connector.ts';
import { tempDir } from '../test-helpers.ts';
import { ConnectorHost } from './host.ts';

let host: ConnectorHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function start(opts: {
  access?: 'read-only' | 'read-write-approved';
  secrets?: Record<string, string>;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  auditPath?: string;
}) {
  const redactor = new Redactor();
  for (const v of Object.values(opts.secrets ?? {})) redactor.add(v);
  host = await ConnectorHost.start(
    [
      {
        component: fakeComponent(opts.settings),
        access: opts.access ?? 'read-only',
        secrets: opts.secrets ?? {},
      },
    ],
    {
      redactor,
      log: jsonLogger(() => undefined, redactor),
      launcher: fakeLauncher(),
      env: opts.env ?? {},
      ...(opts.auditPath ? { audit: new AuditLog(opts.auditPath, redactor) } : {}),
    },
  );
  return host;
}

async function whoami(h: ConnectorHost) {
  const result = await h.call('fakek8s__whoami', {});
  return JSON.parse(result.text) as {
    env: string[];
    fakeToken: string | null;
    fakeUrl: string | null;
    args: string[];
    cwd: string;
    cwdFiles: string[];
    config: string | null;
  };
}

describe('ConnectorHost', () => {
  it('exposes only classified tools, prefixed with the connector id', async () => {
    const h = await start({});
    expect(
      h
        .tools()
        .map((t) => [t.name, t.risk])
        .sort(),
    ).toEqual([
      ['fakek8s__pods_log', 'read'],
      ['fakek8s__resources_scale', 'write'],
      ['fakek8s__whoami', 'read'],
      ['fakek8s__wipe_everything', 'destructive'],
    ]);
    expect(h.get('fakek8s__not_in_manifest')).toBeUndefined();
  });

  it('audits unclassified tools as blocked', async () => {
    const auditPath = join(await tempDir(), 'audit.jsonl');
    await start({ auditPath });
    const records = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(records).toEqual([
      expect.objectContaining({
        event: 'tool.call',
        connector: 'fakek8s',
        tool: 'not_in_manifest',
        risk: 'unclassified',
        decision: 'blocked',
      }),
    ]);
  });

  it('starts the server in an empty private folder with a minimal environment', async () => {
    const h = await start({
      env: {
        FAKE_INHERITED: 'yes',
        SOME_OTHER_SECRET: 'never-passed',
        GITHUB_TOKEN: 'other-connector',
      },
      settings: { namespaces: ['api', 'web'], url: 'http://fake:1' },
    });
    const seen = await whoami(h);
    expect(seen.env).toContain('FAKE_INHERITED');
    expect(seen.env).not.toContain('SOME_OTHER_SECRET');
    expect(seen.env).not.toContain('GITHUB_TOKEN');
    expect(seen.fakeUrl).toBe('http://fake:1');
    expect(seen.cwd).toContain('kodra-mcp-fakek8s-');
    expect(seen.cwdFiles).toEqual(['server-config']);
    expect(seen.config).toBe('allowed = ["pods_log"]\n');
    expect(seen.args).toEqual([
      '--fixed',
      'api,web',
      '--read-only',
      '--config',
      expect.stringContaining('server-config'),
    ]);
  });

  it('passes this connector’s secret in the environment and as a 0600 file, never as an argument', async () => {
    const h = await start({
      access: 'read-write-approved',
      secrets: { token: 'fake-token-value-123' },
    });
    const seen = await whoami(h);
    expect(seen.fakeToken).toBe('fake-token-value-123');
    expect(seen.args.join(' ')).not.toContain('fake-token-value-123');
    expect(seen.args).toContain('--token-file');
    expect(seen.args).not.toContain('--read-only');
    expect(seen.cwdFiles).toEqual(['server-config', 'token.secret']);
  });

  it('removes the private folder on close', async () => {
    const h = await start({ secrets: { token: 'x-token-value' } });
    const { cwd } = await whoami(h);
    await h.close();
    host = undefined;
    await expect(readFile(join(cwd, 'token.secret'))).rejects.toThrow();
  });

  it('returns tool text and reports unknown tools', async () => {
    const h = await start({});
    expect((await h.call('fakek8s__pods_log', { namespace: 'api', name: 'web-1' })).text).toContain(
      'connection refused',
    );
    expect(await h.call('fakek8s__nope', {})).toEqual({
      isError: true,
      text: 'unknown tool fakek8s__nope',
    });
  });
});
