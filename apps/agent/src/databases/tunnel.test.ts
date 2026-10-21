import { timingSafeEqual } from 'node:crypto';
import { createServer, connect, type AddressInfo, type Server as NetServer } from 'node:net';
import { Server, utils, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testKeyPair } from './test-keys.ts';
import { fingerprint, openTunnel, TunnelError } from './tunnel.ts';

/**
 * A real SSH server in the test process (ssh2's Server), so the tunnel is checked end to end:
 * the pinned host key, key-only sign-in, and forwarding to a target behind the bastion.
 */

const hostKeys = testKeyPair();
const userKeys = testKeyPair();
const otherKeys = testKeyPair();

function publicKey(text: string) {
  const parsed = utils.parseKey(text);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const allowedUser = publicKey(userKeys.public);
const HOST_FINGERPRINT = fingerprint(publicKey(hostKeys.public).getPublicSSH());

/** What the bastion saw: sessions (shell or exec) asked for, and where it forwarded to. */
const seen = { sessions: 0, forwards: [] as string[] };

let bastion: Server;
let bastionPort = 0;
let echo: NetServer;
let echoPort = 0;

beforeAll(async () => {
  echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as AddressInfo).port;

  bastion = new Server({ hostKeys: [hostKeys.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey' || ctx.username !== 'tunnel') {
        ctx.reject();
        return;
      }
      const blob = allowedUser.getPublicSSH();
      const same =
        ctx.key.algo === allowedUser.type &&
        ctx.key.data.length === blob.length &&
        timingSafeEqual(ctx.key.data, blob);
      if (!same) {
        ctx.reject();
        return;
      }
      if (ctx.signature && ctx.blob) {
        if (allowedUser.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) ctx.accept();
        else ctx.reject();
        return;
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (_accept, reject) => {
        seen.sessions += 1;
        reject();
      });
      client.on('tcpip', (accept, reject, info) => {
        seen.forwards.push(`${info.destIP}:${String(info.destPort)}`);
        if (info.destPort !== echoPort) {
          reject();
          return;
        }
        const channel = accept();
        const socket = connect(info.destPort, info.destIP);
        channel.pipe(socket).pipe(channel);
      });
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => bastion.listen(0, '127.0.0.1', resolve));
  bastionPort = (bastion.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    bastion.close(() => {
      resolve();
    }),
  );
  await new Promise<void>((resolve) =>
    echo.close(() => {
      resolve();
    }),
  );
});

const options = (over: Partial<Parameters<typeof openTunnel>[0]> = {}) => ({
  host: '127.0.0.1',
  port: bastionPort,
  user: 'tunnel',
  hostKey: HOST_FINGERPRINT,
  privateKey: userKeys.private,
  target: { host: '127.0.0.1', port: echoPort },
  timeoutMs: 5_000,
  ...over,
});

describe('SSH tunnel', () => {
  it('forwards to the database behind the bastion, and asks for nothing else', async () => {
    const before = seen.sessions;
    const tunnel = await openTunnel(options());
    const reply = await new Promise<string>((resolve) => {
      tunnel.stream.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('utf8'));
      });
      tunnel.stream.write('ping');
    });
    tunnel.close();
    expect(reply).toBe('ping');
    expect(seen.forwards).toContain(`127.0.0.1:${String(echoPort)}`);
    // No shell, no exec: only the forwarded channel.
    expect(seen.sessions).toBe(before);
  });

  it('refuses a bastion whose host key does not match the pinned fingerprint', async () => {
    const forwards = seen.forwards.length;
    const wrong = fingerprint(publicKey(otherKeys.public).getPublicSSH());
    await expect(openTunnel(options({ hostKey: wrong }))).rejects.toThrow(
      'the tunnel host key does not match the pinned fingerprint: refused',
    );
    // Refused before signing in, so nothing was forwarded.
    expect(seen.forwards.length).toBe(forwards);
  });

  it('says when the bastion refuses the key, without quoting it', async () => {
    const error = await openTunnel(options({ privateKey: otherKeys.private })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as Error).message).toBe('the tunnel host refused the key for this user');
    expect((error as Error).message).not.toContain('PRIVATE KEY');
  });

  it('says when the key cannot be read, without quoting it', async () => {
    const garbage =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key-s3cr3t\n-----END OPENSSH PRIVATE KEY-----'; // gitleaks:allow
    const error = await openTunnel(options({ privateKey: garbage })).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/could not be read/);
    expect((error as Error).message).not.toContain('s3cr3t');
  });

  it('says when the bastion forwards nowhere', async () => {
    await expect(openTunnel(options({ target: { host: '127.0.0.1', port: 1 } }))).rejects.toThrow(
      /refused to forward/,
    );
  });

  it('says when nothing answers', async () => {
    await expect(openTunnel(options({ port: 1 }))).rejects.toThrow(
      'could not connect to the tunnel host',
    );
  });
});
