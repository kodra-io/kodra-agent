import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Added to the inherited environment. Secrets go here, never in the arguments. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** Runs a program without a shell. Tests pass a fake. */
export type Exec = (
  command: string,
  args: readonly string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

/** Output kept per stream: the end of a build log is what explains a failure. */
const MAX_OUTPUT = 256 * 1024;

const keepTail = (text: string) => (text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text);

export const spawnExec: Exec = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    child.stdout.on(
      'data',
      (chunk: Buffer) => (stdout = keepTail(stdout + chunk.toString('utf8'))),
    );
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr = keepTail(stderr + chunk.toString('utf8'))),
    );
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr: signal ? `${stderr}\nstopped by ${signal} (time limit)` : stderr,
      });
    });
  });
