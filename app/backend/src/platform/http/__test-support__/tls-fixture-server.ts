import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tls, { type TLSSocket } from 'node:tls';

/**
 * __test-support__/tls-fixture-server.ts (P15 Unit U3, test-support only) -
 * a bare `node:tls` server for safe-fetch.test.ts's TLS-identity tests.
 * Binds `127.0.0.1` on an ephemeral port (never a fixed port), replies to
 * every connection with a minimal fixed HTTP/1.1 response so the test can
 * assert on `safeFetch`'s own TLS handling without a real HTTP server
 * framework in the loop. Test-only local CA + leaf PEMs live in
 * `../__fixtures__/tls/` - certificate verification is never disabled to
 * make these tests pass (see `scripts/check-no-insecure-tls.ts`); the
 * CLIENT trusts the fixture CA via `safeFetch`'s `ca` option instead.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '__fixtures__', 'tls');

export function readFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

export const CA_CERT = readFixture('ca-cert.pem');
export const LEAF_CERT = readFixture('leaf-cert.pem');
export const LEAF_KEY = readFixture('leaf-key.pem');
export const WRONG_HOST_CERT = readFixture('wrong-host-cert.pem');
export const WRONG_HOST_KEY = readFixture('wrong-host-key.pem');
export const SELF_SIGNED_CERT = readFixture('self-signed-cert.pem');
export const SELF_SIGNED_KEY = readFixture('self-signed-key.pem');

export interface TlsFixtureServer {
  readonly port: number;
  connectionCount(): number;
  close(): Promise<void>;
}

/** Minimal fixed 200 response body every accepted connection replies with. */
const RESPONSE_BODY = '{"ok":true}';

function writeFixedResponse(socket: TLSSocket): void {
  socket.on('data', () => {
    const body = RESPONSE_BODY;
    socket.write(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(
        Buffer.byteLength(body),
      )}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.end();
  });
}

/**
 * Starts a TLS fixture server using `cert`/`key` (and optionally its own
 * `ca` for client verification - unused here, server-auth only). Tracks how
 * many TCP connections were actually accepted, so "zero internal requests"
 * assertions have a real counter to check instead of trusting error classes
 * alone.
 */
export function startTlsFixtureServer(cert: Buffer, key: Buffer): Promise<TlsFixtureServer> {
  let connections = 0;
  const server = tls.createServer({ cert, key }, (socket) => {
    connections += 1;
    writeFixedResponse(socket);
  });
  server.on('error', () => undefined);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('tls-fixture-server: server.address() did not return an AddressInfo'));
        return;
      }
      resolve({
        port: address.port,
        connectionCount: () => connections,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
