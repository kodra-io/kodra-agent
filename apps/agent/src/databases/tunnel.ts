import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel } from 'ssh2';

/**
 * An SSH tunnel to a database behind a bastion. The bastion's host key must match the pinned
 * fingerprint (no trust on first use), and the session only opens one forwarded channel: no
 * shell, no exec, no agent or X11 forwarding. The channel is handed to the database driver as
 * its socket, so no local port is ever opened.
 */

export interface TunnelOptions {
  host: string;
  port: number;
  user: string;
  /** The pinned host key fingerprint, as `ssh-keygen -lf` prints it: SHA256:<base64>. */
  hostKey: string;
  privateKey: string;
  /** Where the bastion connects on to: the database. */
  target: { host: string; port: number };
  timeoutMs: number;
}

export interface Tunnel {
  /** The forwarded connection, shaped like a socket for the drivers. */
  stream: Duplex;
  close: () => void;
}

/** Why a tunnel could not open, in words that never include a secret. */
export class TunnelError extends Error {}

/** The SHA256 fingerprint of a host key, as OpenSSH prints it (base64 without padding). */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function sameFingerprint(a: string, b: string): boolean {
  return a.replace(/=+$/, '') === b.replace(/=+$/, '');
}

/**
 * The drivers expect a net.Socket: they call connect(), setNoDelay(), and setKeepAlive(), and
 * wait for `connect`. The channel is already connected, so these only signal that.
 */
function asSocket(channel: ClientChannel): Duplex {
  const socket = channel as ClientChannel & {
    connect: () => Duplex;
    setNoDelay: () => Duplex;
    setKeepAlive: () => Duplex;
    setTimeout: () => Duplex;
    ref: () => Duplex;
    unref: () => Duplex;
  };
  socket.connect = () => {
    process.nextTick(() => socket.emit('connect'));
    return socket;
  };
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  socket.setTimeout = () => socket;
  socket.ref = () => socket;
  socket.unref = () => socket;
  return socket;
}

export function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch = false;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new TunnelError(message));
    };
    const timer = setTimeout(() => {
      fail(`the tunnel host gave no answer within ${String(opts.timeoutMs / 1000)}s`);
    }, opts.timeoutMs);
    client.on('ready', () => {
      client.forwardOut('127.0.0.1', 0, opts.target.host, opts.target.port, (error, channel) => {
        clearTimeout(timer);
        if (error) {
          fail(
            'the tunnel host refused to forward to the database (check permitopen on the bastion)',
          );
          return;
        }
        settled = true;
        channel.on('close', () => client.end());
        resolve({ stream: asSocket(channel), close: () => client.end() });
      });
    });
    client.on('error', (error: Error & { level?: string }) => {
      clearTimeout(timer);
      if (mismatch) {
        fail('the tunnel host key does not match the pinned fingerprint: refused');
      } else if (error.level === 'client-authentication') {
        fail('the tunnel host refused the key for this user');
      } else if (error.level === 'client-timeout') {
        fail('the tunnel host did not answer in time');
      } else {
        fail('could not connect to the tunnel host');
      }
    });
    try {
      client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.user,
        privateKey: opts.privateKey,
        readyTimeout: opts.timeoutMs,
        // Keys only: never a password, keyboard prompt, or the local SSH agent.
        tryKeyboard: false,
        agentForward: false,
        hostVerifier: (key: Buffer) => {
          const ok = sameFingerprint(fingerprint(key), opts.hostKey);
          if (!ok) mismatch = true;
          return ok;
        },
      });
    } catch {
      // ssh2 throws synchronously on a key it cannot parse; its message may quote the key.
      clearTimeout(timer);
      fail('the tunnel private key could not be read (use an unencrypted OpenSSH or PEM key)');
    }
  });
}
