import net from 'node:net';
import type { ResolvedAddress, Resolver } from '../safe-fetch.js';

/**
 * __test-support__/safe-fetch-test-helpers.ts (P15 Unit U3, test-support
 * only) - small helpers shared by `safe-fetch.test.ts` and
 * `safe-fetch-tls.test.ts` (split into two files purely to respect the
 * 300-line cap on each).
 */

/** A stub resolver that always returns the given answers, regardless of hostname. */
export function resolverFor(answers: ResolvedAddress[]): Resolver {
  return async () => answers;
}

/**
 * A TCP listener on `127.0.0.1:<ephemeral>` that calls `onHit()` if
 * anything ever connects to it - the "prove nothing internal was dialled"
 * primitive used by the DNS-rebinding and redirect tests.
 */
export function startForbiddenTarget(
  onHit: () => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      onHit();
      socket.destroy();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('startForbiddenTarget: no AddressInfo'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
