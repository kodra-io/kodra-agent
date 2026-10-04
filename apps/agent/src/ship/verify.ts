import { randomUUID } from 'node:crypto';
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
}

/**
 * Starts the container the way the chart runs it (read-only root filesystem, writable /tmp)
 * and waits for an HTTP answer below 500 on its port. Always removes the container.
 */
export async function smokeTest(exec: Exec, o: SmokeOptions): Promise<Check> {
  const name = `kodra-ship-${randomUUID().slice(0, 8)}`;
  const port = String(o.port);
  const run = await exec(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-p',
      `127.0.0.1::${port}`,
      o.image,
    ],
    { timeoutMs: 60_000 },
  );
  if (run.code !== 0) {
    return { ok: false, detail: 'the container did not start', log: tail(run.stderr) };
  }
  const path = o.healthPath ?? '/';
  try {
    const mapped = await exec('docker', ['port', name, `${port}/tcp`], { timeoutMs: 30_000 });
    const address = mapped.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^127\.0\.0\.1:\d+$/.test(l));
    if (!address) {
      return { ok: false, detail: `port ${port} is not published`, log: tail(mapped.stderr) };
    }
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
    await exec('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
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
