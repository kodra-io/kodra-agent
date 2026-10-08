import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Exec } from './exec.ts';

export type Check = { ok: true; detail: string } | { ok: false; detail: string; log: string };

const tail = (text: string, chars = 8000) => (text.length > chars ? text.slice(-chars) : text);

export async function toolAvailable(exec: Exec, command: 'docker' | 'helm'): Promise<boolean> {
  const args = command === 'docker' ? ['version', '--format', '{{.Server.Version}}'] : ['version'];
  const result = await exec(command, args, { timeoutMs: 30_000 });
  return result.code === 0;
}

export async function buildImage(
  exec: Exec,
  dir: string,
  tag: string,
  timeoutMs: number,
): Promise<Check> {
  const result = await exec('docker', ['build', '--progress=plain', '-t', tag, '.'], {
    cwd: dir,
    timeoutMs,
  });
  return result.code === 0
    ? { ok: true, detail: `The image builds (\`docker build\`, tagged ${tag}).` }
    : { ok: false, detail: 'docker build failed', log: tail(`${result.stdout}\n${result.stderr}`) };
}

export interface SmokeOptions {
  image: string;
  port: number;
  healthPath: string | null;
  timeoutMs: number;
  pollMs?: number;
  fetch: typeof fetch;
  /**
   * The agent's own container, when `ship` runs inside one (with the Docker socket). Its
   * 127.0.0.1 is not the host's, so the app container is reached on a private network instead.
   */
  selfContainer?: string | null;
}

/** This process's container id, if it runs in a Docker container; null on a host. */
export function selfContainer(): string | null {
  return existsSync('/.dockerenv') ? hostname() : null;
}

/**
 * Starts the container the way the chart runs it (read-only root filesystem, writable /tmp)
 * and waits for an HTTP answer below 500 on its port. Always removes what it created.
 */
export async function smokeTest(exec: Exec, o: SmokeOptions): Promise<Check> {
  const id = randomUUID().slice(0, 8);
  const name = `kodra-ship-${id}`;
  const port = String(o.port);
  const self = o.selfContainer ?? null;
  const network = `kodra-ship-${id}`;
  const cleanup: string[][] = [];
  const docker = (args: string[], timeoutMs = 30_000) => exec('docker', args, { timeoutMs });

  try {
    let address: string;
    if (self) {
      const created = await docker(['network', 'create', network]);
      if (created.code !== 0) {
        return {
          ok: false,
          detail: 'could not create a network for the test',
          log: tail(created.stderr),
        };
      }
      cleanup.unshift(['network', 'rm', network]);
    }
    const run = await docker(
      [
        'run',
        '-d',
        '--name',
        name,
        '--read-only',
        '--tmpfs',
        '/tmp',
        ...(self ? ['--network', network] : ['-p', `127.0.0.1::${port}`]),
        o.image,
      ],
      60_000,
    );
    if (run.code !== 0) {
      return { ok: false, detail: 'the container did not start', log: tail(run.stderr) };
    }
    cleanup.unshift(['rm', '-f', name]);
    if (self) {
      const joined = await docker(['network', 'connect', network, self]);
      if (joined.code !== 0) {
        return { ok: false, detail: 'could not join the test network', log: tail(joined.stderr) };
      }
      cleanup.unshift(['network', 'disconnect', '--force', network, self]);
      address = `${name}:${port}`;
    } else {
      const mapped = await docker(['port', name, `${port}/tcp`]);
      const published = mapped.stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^127\.0\.0\.1:\d+$/.test(l));
      if (!published) {
        return { ok: false, detail: `port ${port} is not published`, log: tail(mapped.stderr) };
      }
      address = published;
    }

    const path = o.healthPath ?? '/';
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await o.fetch(`http://${address}${path}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2000),
        });
        if (res.status < 500) {
          return {
            ok: true,
            detail: `The container starts with a read-only root filesystem and answers HTTP ${String(res.status)} on ${path} (port ${port}).`,
          };
        }
      } catch {
        // Not listening yet.
      }
      const state = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name], {
        timeoutMs: 30_000,
      });
      if (state.stdout.trim() === 'false') {
        const logs = await exec('docker', ['logs', '--tail', '100', name], { timeoutMs: 30_000 });
        return {
          ok: false,
          detail: 'the container exited',
          log: tail(`${logs.stdout}\n${logs.stderr}`),
        };
      }
      await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
    }
    const logs = await exec('docker', ['logs', '--tail', '100', name], { timeoutMs: 30_000 });
    return {
      ok: false,
      detail: `no HTTP answer on ${path} (port ${port}) within ${String(Math.round(o.timeoutMs / 1000))} seconds`,
      log: tail(`${logs.stdout}\n${logs.stderr}`),
    };
  } finally {
    // Newest first: leave the network, remove the container, then remove the network.
    for (const args of cleanup) await docker(args, 60_000);
  }
}

export async function helmCheck(exec: Exec, dir: string, chartDir: string): Promise<Check> {
  const lint = await exec('helm', ['lint', chartDir], { cwd: dir, timeoutMs: 120_000 });
  if (lint.code !== 0) {
    return { ok: false, detail: 'helm lint failed', log: tail(`${lint.stdout}\n${lint.stderr}`) };
  }
  const render = await exec('helm', ['template', 'kodra-ship', chartDir], {
    cwd: dir,
    timeoutMs: 120_000,
  });
  if (render.code !== 0) {
    return { ok: false, detail: 'helm template failed', log: tail(render.stderr) };
  }
  return { ok: true, detail: `\`helm lint\` and \`helm template\` pass for ${chartDir}.` };
}
