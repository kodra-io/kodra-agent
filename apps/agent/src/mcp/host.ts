import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  stdioRuntimes,
  type AccessLevel,
  type Manifest,
  type McpStdioRuntime,
  type ToolGuard,
  type ValueSource,
} from '@kodra-agent/schema';
import type { AuditLog } from '../audit.ts';
import type { Component } from '../config.ts';
import type { Logger } from '../io.ts';
import type { Risk } from '../policy.ts';
import type { Redactor } from '../redactor.ts';
import { binaryPath, mcpCacheDir, preinstalledPath } from './fetch.ts';

/** A tool the model may see: classified in its manifest and offered by its server. */
export interface HostedTool {
  /** `<connector>__<tool>`: unique across connectors and valid as a model tool name. */
  name: string;
  connector: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  guards: readonly ToolGuard[];
  access: AccessLevel | undefined;
  settings: Record<string, unknown>;
  /** Default branch per repo, for not-default-branch guards. */
  defaultBranches?: ReadonlyMap<string, string | null>;
  /** Settings of required connectors, for guards with `from`. */
  sharedSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Index into the host's running servers. */
  server: number;
}

export interface ConnectorFailure {
  connector: string;
  displayName: string;
  /** The server's name, for connectors that run several. */
  server: string | undefined;
  reason: string;
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
}

export interface Launch {
  command: string;
  args: string[];
}

export interface HostOptions {
  redactor: Redactor;
  log: Logger;
  audit?: AuditLog | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides how a server is started (tests run fake servers). */
  launcher?: (manifest: Manifest, runtime: McpStdioRuntime) => Launch;
  timeoutMs?: number;
}

export interface ConnectorInput {
  component: Component;
  access: AccessLevel | undefined;
  /** Resolved secret values for this connector only, keyed by manifest secret key. */
  secrets: Readonly<Record<string, string>>;
  /**
   * Secrets of other connectors, by connector id. Only those this manifest `requires` are
   * ever read (GitHub Actions uses the GitHub token).
   */
  sharedSecrets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Settings of other connectors, by connector id (only required ones are passed on). */
  sharedSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  defaultBranches?: ReadonlyMap<string, string | null>;
}

interface Running {
  connector: string;
  label: string;
  client: Client;
  dir: string;
}

const SEP = '__';

function settingValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Whether an `onlyIf` server is wanted: unset settings mean yes, so old configs keep it. */
function wanted(runtime: McpStdioRuntime, settings: Readonly<Record<string, unknown>>): boolean {
  if (!runtime.onlyIf) return true;
  const value = settings[runtime.onlyIf.setting];
  return !Array.isArray(value) || value.map(String).includes(runtime.onlyIf.includes);
}

/** Inherited environment variables whose values are registered with the redactor. */
const SECRET_ENV = /SECRET|TOKEN|PASSWORD|ACCESS_KEY/;

/** Whether a manifest lists a connector in `requires`, the only way to share its values. */
function requires(manifest: Manifest, connector: string): boolean {
  return manifest.requires.some((r) =>
    r.anyOf.some((alt) => 'connector' in alt && alt.connector === connector),
  );
}

/**
 * The default launcher: a pinned, checksum-verified binary; a server preinstalled in the
 * agent image from a lockfile; or else uvx or npx at the pinned version.
 */
export function defaultLauncher(env: Readonly<Record<string, string | undefined>>) {
  return (manifest: Manifest, runtime: McpStdioRuntime): Launch => {
    const source = runtime.source;
    const preinstalled = preinstalledPath(runtime, mcpCacheDir(env));
    if (preinstalled && existsSync(preinstalled)) return { command: preinstalled, args: [] };
    if (source.kind === 'pypi') {
      return {
        command: 'uvx',
        args: ['--from', `${source.package}==${source.version}`, source.command],
      };
    }
    if (source.kind === 'npm') {
      return {
        command: 'npx',
        args: ['--yes', '--package', `${source.package}@${source.version}`, '--', source.command],
      };
    }
    const path = binaryPath(runtime, mcpCacheDir(env));
    if (!path) throw new Error(`no ${manifest.displayName} server build for this platform`);
    return { command: path, args: [] };
  };
}

/**
 * Starts one MCP server per enabled connector and exposes only the tools its manifest
 * classifies. Each server gets a private working folder (some servers load a .env from
 * their working directory), a minimal environment, and only its own connector's secrets.
 */
export class ConnectorHost {
  private readonly running: Running[] = [];
  private readonly toolsByName = new Map<string, HostedTool>();
  private readonly failed: ConnectorFailure[] = [];
  private readonly opts: HostOptions;

  private constructor(opts: HostOptions) {
    this.opts = opts;
  }

  /**
   * Starts every connector's servers. A server that cannot start is recorded and skipped, so
   * one broken connector (a missing kubeconfig, an unreachable registry) never takes the
   * agent down: the rest keep working, and `failures()` says what is missing and why.
   */
  static async start(inputs: readonly ConnectorInput[], opts: HostOptions): Promise<ConnectorHost> {
    const host = new ConnectorHost(opts);
    for (const input of inputs) {
      for (const runtime of stdioRuntimes(input.component.manifest)) {
        if (!wanted(runtime, input.component.settings)) continue;
        try {
          await host.startOne(input, runtime);
        } catch (error) {
          const manifest = input.component.manifest;
          const reason = opts.redactor.redact(
            error instanceof Error ? error.message : String(error),
          );
          host.failed.push({
            connector: manifest.id,
            displayName: manifest.displayName,
            server: runtime.name,
            reason,
          });
          await opts.audit
            ?.append({ event: 'error', actor: 'agent', connector: manifest.id, detail: reason })
            .catch(() => undefined);
        }
      }
    }
    return host;
  }

  /** Servers that could not start, with the reason (redacted). */
  failures(): readonly ConnectorFailure[] {
    return this.failed;
  }

  tools(): HostedTool[] {
    return [...this.toolsByName.values()];
  }

  get(name: string): HostedTool | undefined {
    return this.toolsByName.get(name);
  }

  private async startOne(input: ConnectorInput, runtime: McpStdioRuntime): Promise<void> {
    const { component, access, secrets } = input;
    const manifest = component.manifest;
    const env = this.opts.env ?? process.env;
    const dir = await mkdtemp(join(tmpdir(), `kodra-mcp-${manifest.id}-`));

    // Secret files are written owner-only into the private folder and never logged.
    const secretFiles = new Map<string, string>();
    const resolve = async (source: ValueSource): Promise<string | undefined> => {
      if ('value' in source) return source.value;
      if ('setting' in source) {
        let raw: unknown = component.settings[source.setting];
        if (source.from !== undefined) {
          raw = requires(manifest, source.from)
            ? input.sharedSettings?.[source.from]?.[source.setting]
            : undefined;
        }
        const value = settingValue(raw);
        return value === undefined
          ? undefined
          : `${value.replace(/\/+$/, '')}${source.suffix ?? ''}`;
      }
      if ('secret' in source) {
        if (source.from === undefined) return secrets[source.secret];
        // Defense in depth: the registry test also enforces this for every manifest.
        return requires(manifest, source.from)
          ? input.sharedSecrets?.[source.from]?.[source.secret]
          : undefined;
      }
      const value = secrets[source.secretFile];
      if (value === undefined) return undefined;
      const existing = secretFiles.get(source.secretFile);
      if (existing) return existing;
      const path = join(dir, `${source.secretFile}.secret`);
      await writeFile(path, value, { mode: 0o600 });
      secretFiles.set(source.secretFile, path);
      return path;
    };
    const resolveArgs = async (parts: McpStdioRuntime['args']): Promise<string[]> => {
      const out: string[] = [];
      for (const part of parts) {
        if (typeof part === 'string') out.push(part);
        else {
          const value = await resolve(part);
          if (value !== undefined) out.push(value);
        }
      }
      return out;
    };

    const launch = (this.opts.launcher ?? defaultLauncher(env))(manifest, runtime);
    const args = [...launch.args, ...(await resolveArgs(runtime.args))];
    if (access) args.push(...(runtime.accessArgs?.[access] ?? []));
    for (const optional of runtime.secretArgs ?? []) {
      if (secrets[optional.secret] !== undefined) args.push(...(await resolveArgs(optional.args)));
    }
    if (runtime.configFile) {
      const path = join(dir, 'server-config');
      await writeFile(path, runtime.configFile.content, { mode: 0o600 });
      args.push(runtime.configFile.arg, path);
    }

    const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
    for (const name of runtime.inheritEnv ?? []) {
      const value = env[name];
      if (value === undefined) continue;
      // Inherited credentials (like AWS keys for an EKS kubeconfig) are secrets too.
      if (SECRET_ENV.test(name) && !name.endsWith('_FILE')) this.opts.redactor.add(value);
      childEnv[name] = value;
    }
    for (const [name, source] of Object.entries(runtime.env)) {
      const value = await resolve(source);
      if (value !== undefined) childEnv[name] = value;
    }

    const transport = new StdioClientTransport({
      command: launch.command,
      args,
      env: childEnv,
      cwd: dir,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim().slice(0, 2000);
      if (line)
        this.opts.log.warn('connector stderr', {
          connector: manifest.id,
          line: this.opts.redactor.redact(line),
        });
    });
    const client = new Client({ name: 'kodra-agent', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: this.opts.timeoutMs ?? 30_000 });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      // No `cause`: the original error may carry an unredacted secret.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `could not start the ${manifest.displayName} connector: ${this.opts.redactor.redact(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    const label = `${manifest.id}${runtime.name ? `/${runtime.name}` : ''}`;
    const serverIndex = this.running.push({ connector: manifest.id, label, client, dir }) - 1;

    let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
      ({ tools } = await client.listTools(undefined, { timeout: this.opts.timeoutMs ?? 30_000 }));
    } catch (error) {
      this.running.pop();
      await client.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    for (const tool of tools) {
      if (manifest.hiddenTools?.includes(tool.name)) continue;
      const risk = manifest.tools[tool.name];
      if (risk === undefined) {
        // Unclassified tools are never shown to the model (SPEC section 6).
        await this.opts.audit
          ?.append({
            event: 'tool.call',
            actor: 'agent',
            connector: manifest.id,
            tool: tool.name,
            risk: 'unclassified',
            decision: 'blocked',
            detail: 'not classified in the manifest; hidden from the model',
          })
          .catch(() => undefined);
        continue;
      }
      const name = `${manifest.id}${SEP}${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      if (this.toolsByName.has(name)) {
        throw new Error(
          `${label} offers ${tool.name}, which another ${manifest.displayName} server already offers`,
        );
      }
      this.toolsByName.set(name, {
        name,
        connector: manifest.id,
        tool: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
        risk,
        guards: manifest.guards?.[tool.name] ?? [],
        access,
        settings: component.settings,
        ...(input.defaultBranches ? { defaultBranches: input.defaultBranches } : {}),
        ...(input.sharedSettings ? { sharedSettings: input.sharedSettings } : {}),
        server: serverIndex,
      });
    }
  }

  /** Calls a tool on its server. The caller has already run the policy engine. */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const tool = this.toolsByName.get(name);
    const server = tool ? this.running[tool.server] : undefined;
    if (!tool || !server) return { isError: true, text: `unknown tool ${name}` };
    const result = await server.client.callTool({ name: tool.tool, arguments: args }, undefined, {
      timeout: this.opts.timeoutMs ?? 60_000,
      ...(signal ? { signal } : {}),
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((part: { type?: string; text?: string }) =>
        part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : `[${part.type ?? 'content'} omitted]`,
      )
      .join('\n');
    return { isError: result.isError === true, text };
  }

  async close(): Promise<void> {
    for (const server of this.running.splice(0)) {
      await server.client.close().catch(() => undefined);
      await rm(server.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
