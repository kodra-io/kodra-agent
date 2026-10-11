import type { SelfKubernetes } from './console/config-backend.ts';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { jsonLogger, memoryTerminal, type Prompter } from './io.ts';
import type { KubernetesClient, KubernetesFactory } from './kubernetes.ts';
import { Redactor } from './redactor.ts';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local HTTP server standing in for GitHub, Slack, Anthropic, and the rest. */
export async function fakeServer(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const path = (req.url ?? '').split('?')[0] ?? '';
    const handler = routes[`${req.method ?? 'GET'} ${path}`] ?? routes[path];
    if (handler) handler(req, res);
    else json(res, 404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Answers questions from a script, in order, and records what was asked. */
export function scriptedPrompter(answers: (string | boolean)[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (message: string) => {
    asked.push(message);
    if (answers.length === 0)
      throw new Error(`unexpected question: ${message} (asked: ${asked.join(' / ')})`);
    return answers.shift();
  };
  return {
    asked,
    secret: (m) => Promise.resolve(String(next(m))),
    text: (m) => Promise.resolve(String(next(m))),
    choice: <T extends string>(m: string) => Promise.resolve(next(m) as T),
    confirm: (m) => Promise.resolve(next(m) === true),
  };
}

export function fakeKubernetes(behavior: Partial<KubernetesClient> = {}): KubernetesFactory & {
  calls: { kubeconfig: string | undefined; op: string; args: unknown[] }[];
} {
  const calls: { kubeconfig: string | undefined; op: string; args: unknown[] }[] = [];
  const factory = ((kubeconfig?: string) => ({
    listPods: async (ns: string, timeout: number) => {
      calls.push({ kubeconfig, op: 'listPods', args: [ns, timeout] });
      return behavior.listPods ? behavior.listPods(ns, timeout) : 1;
    },
    upsertSecret: async (ns: string, name: string, data: Record<string, string>) => {
      calls.push({ kubeconfig, op: 'upsertSecret', args: [ns, name, data] });
      return behavior.upsertSecret ? behavior.upsertSecret(ns, name, data) : 'created';
    },
  })) as KubernetesFactory & { calls: typeof calls };
  factory.calls = calls;
  return factory;
}

export function testContext(overrides: Partial<Context> = {}) {
  const redactor = overrides.redactor ?? new Redactor();
  const term = memoryTerminal(redactor);
  const logLines: string[] = [];
  const ctx: Context = {
    term,
    log: jsonLogger((l) => logLines.push(l), redactor),
    redactor,
    prompter: null,
    env: {},
    fetch: globalThis.fetch,
    kubernetes: fakeKubernetes(),
    platform: 'linux',
    probeTimeoutMs: 2000,
    ...overrides,
  };
  return { ctx, term, logLines, output: () => [...term.stdout, ...term.stderr].join('\n') };
}

export async function tempDir(): Promise<string> {
  // On Windows, stay on the working drive so the folder has a drive-less POSIX form.
  const base =
    process.platform === 'win32'
      ? join(process.cwd(), 'node_modules', '.cache', 'kodra-tests')
      : tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'kodra-agent-test-'));
}

/** The POSIX absolute form of a local path, as kodra-agent.yaml requires (C:\a\b -> /a/b). */
export function posixPath(path: string): string {
  return process.platform === 'win32' ? path.slice(2).replaceAll('\\', '/') : path;
}

/** Writes a kodra-agent.yaml into a fresh folder and returns its path. */
export async function writeConfig(yaml: string, dir?: string): Promise<string> {
  const folder = dir ?? (await tempDir());
  const path = join(folder, 'kodra-agent.yaml');
  await writeFile(path, yaml, 'utf8');
  return path;
}

export function configYaml(opts: {
  target?: 'compose' | 'kubernetes';
  auditPath: string;
  model?: string;
  connectors?: string;
  approvers?: string[];
}): string {
  return `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: test-agent
spec:
  target: ${opts.target ?? 'compose'}
  model:
${opts.model ?? '    provider: ollama\n    name: m\n    baseUrl: http://127.0.0.1:9'}
  connectors:
${opts.connectors ?? '    {}'}
  policy:
    approvals:
      approvers: [${(opts.approvers ?? ['@omar']).map((a) => `'${a}'`).join(', ')}]
  audit:
    path: ${opts.auditPath}
`;
}

/** A Slack connection that records messages instead of talking to Slack. */
export function fakeSlack(users: { id: string; name: string; displayName: string }[] = []) {
  const posted: {
    channel: string;
    threadTs?: string | undefined;
    text: string;
    blocks?: unknown[] | undefined;
    ts: string;
  }[] = [];
  const updated: { channel: string; ts: string; text: string; blocks?: unknown[] | undefined }[] =
    [];
  let handlers: import('./slack/api.ts').SlackHandlers | null = null;
  let stopped = false;
  let n = 0;
  const api: import('./slack/api.ts').SlackApi = {
    postMessage: (args) => {
      const ts = `1700000000.${String(++n).padStart(6, '0')}`;
      // Like Slack: a channel name resolves to the channel id.
      const channel = args.channel.startsWith('#') ? 'C0CHANNEL' : args.channel;
      posted.push({ ...args, channel, ts });
      return Promise.resolve({ channel, ts });
    },
    updateMessage: (args) => {
      updated.push(args);
      return Promise.resolve();
    },
    listUsers: () => Promise.resolve(users),
  };
  return {
    api,
    posted,
    updated,
    get handlers() {
      if (!handlers) throw new Error('slack not started');
      return handlers;
    },
    get stopped() {
      return stopped;
    },
    connection: (): import('./slack/api.ts').SlackConnection => ({
      api,
      start: (h) => {
        handlers = h;
        return Promise.resolve();
      },
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
    }),
  };
}

type MockGenerate = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type MockCallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/** A generate result as the stream a provider would send, text in small pieces. */
export function asStreamResult(result: MockGenerate) {
  const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
  for (const [i, part] of result.content.entries()) {
    if (part.type === 'text') {
      const id = `t${String(i)}`;
      parts.push({ type: 'text-start', id });
      for (let at = 0; at < part.text.length; at += 8) {
        parts.push({ type: 'text-delta', id, delta: part.text.slice(at, at + 8) });
      }
      parts.push({ type: 'text-end', id });
    } else {
      parts.push(part);
    }
  }
  parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
  return {
    stream: convertArrayToReadableStream(parts) as ReturnType<
      typeof convertArrayToReadableStream<never>
    >,
  };
}

/**
 * A scripted model that answers the same way whether it is asked to generate or to stream
 * (the console streams; the CLI and Slack generate). `calls` records every call's options.
 */
export function scriptedModel(
  script: MockGenerate[] | ((options: MockCallOptions) => MockGenerate | Promise<MockGenerate>),
) {
  let next = 0;
  const calls: MockCallOptions[] = [];
  const answer = async (options: MockCallOptions): Promise<MockGenerate> => {
    calls.push(options);
    if (typeof script === 'function') return script(options);
    const result = script[next++];
    if (!result) throw new Error('the scripted model ran out of answers');
    return result;
  };
  const model = new MockLanguageModelV4({
    doGenerate: answer,
    doStream: async (options) => asStreamResult(await answer(options)),
  });
  return Object.assign(model, { calls });
}

/** The agent's own settings ConfigMap (empty, as the chart makes it), Secret, and Deployment. */
export function fakeSelfKubernetes() {
  const state = {
    configMap: {} as Record<string, string>,
    secret: {} as Record<string, string>,
    restartedAt: [] as string[],
    calls: [] as string[],
  };
  const client: SelfKubernetes = {
    readConfigMap(namespace, name) {
      state.calls.push(`get configmap ${namespace}/${name}`);
      return Promise.resolve({ ...state.configMap });
    },
    patchConfigMap(namespace, name, data) {
      state.calls.push(`patch configmap ${namespace}/${name}`);
      Object.assign(state.configMap, data);
      return Promise.resolve();
    },
    patchSecret(namespace, name, data) {
      state.calls.push(`patch secret ${namespace}/${name}`);
      state.secret = Object.fromEntries(
        Object.entries({ ...state.secret, ...data }).filter(
          (e): e is [string, string] => e[1] !== null,
        ),
      );
      return Promise.resolve();
    },
    restartDeployment(namespace, name, at) {
      state.calls.push(`patch deployment ${namespace}/${name}`);
      state.restartedAt.push(at);
      return Promise.resolve();
    },
  };
  return { client, state };
}
