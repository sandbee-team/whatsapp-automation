import { createServer, type Server, type Socket } from 'node:net';

/**
 * hung-tcp-proxy.ts (P06 Unit U5, test-support only) - a bare `net` server
 * that accepts TCP connections and never writes a single byte back
 * (half-open simulation): a real `ioredis` client pointed at this server
 * completes its TCP handshake, so `lazyConnect`/`connectTimeout` never
 * fires, but every command it sends afterward sits forever with no
 * response - the exact failure mode a hard per-command timeout
 * (`lease-redis.ts`'s `withTimeout`) exists to bound.
 *
 * Not a real proxy (it never connects onward to anything) - "proxy" in the
 * filename matches the phase task's naming; the behaviour needed here is
 * simply "accept and go silent", which is sufficient to exercise the
 * timeout path without a real upstream Redis.
 */
export interface HungTcpProxy {
  readonly port: number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createHungTcpProxy(): HungTcpProxy {
  const server: Server = createServer((socket: Socket) => {
    // Accept the connection, read and discard anything sent, reply to
    // nothing - the defining behaviour of a half-open connection.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
  });
  server.on('error', () => undefined);

  let resolvedPort = 0;

  return {
    get port(): number {
      return resolvedPort;
    },
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('hung-tcp-proxy: server.address() did not return an AddressInfo'));
            return;
          }
          resolvedPort = address.port;
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
