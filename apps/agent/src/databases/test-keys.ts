import { utils } from 'ssh2';

/**
 * An ed25519 key pair for tests. ssh2's generator drops a leading zero byte about one time in
 * 300, making a key that neither ssh2 nor OpenSSH accepts (keys from ssh-keygen are fine), so
 * make another.
 */
export function testKeyPair(): { private: string; public: string } {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519');
    const ok =
      !(utils.parseKey(pair.public) instanceof Error) &&
      !(utils.parseKey(pair.private) instanceof Error);
    if (ok) return pair;
  }
}
