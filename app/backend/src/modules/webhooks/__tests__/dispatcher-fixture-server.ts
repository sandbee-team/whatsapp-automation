import tls, { type TLSSocket } from 'node:tls';
import {
  CA_CERT,
  LEAF_CERT,
  LEAF_KEY,
} from '../../../platform/http/__test-support__/tls-fixture-server.js';

/**
 * dispatcher-fixture-server.ts (P15 U5, step 7, test-support only) - a
 * configurable HTTPS fixture server for dispatcher.integration.test.ts,
 * built on the SAME leaf/CA fixture certificates
 * `platform/http/__test-support__/tls-fixture-server.ts` already
 * establishes (read-only reuse - this module never edits `safe-fetch*` or
 * the shared fixture, per this unit's own file scope). Unlike that fixed-
 * response helper, this one records every accepted request (method,
 * headers, body) and replies with a caller-controlled STATUS SEQUENCE (one
 * entry consumed per request, the last entry repeats once exhausted) - the
 * shape the dispatcher's terminal/retry/backoff tests need.
 */

export { CA_CERT };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface DispatcherFixtureServer {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function parseHeaders(rawHeaderLines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaderLines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * `statusSequence` - one HTTP status served per accepted CONNECTION, in
 * order (the last value repeats once exhausted) - the dispatcher opens one
 * connection per delivery attempt, so this maps 1:1 onto "attempt N gets
 * status X".
 */
export function startDispatcherFixtureServer(
  statusSequence: number[],
): Promise<DispatcherFixtureServer> {
  const requests: RecordedRequest[] = [];
  let cursor = 0;

  const server = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket: TLSSocket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerBlock = buffer.slice(0, headerEnd);
      const [requestLine, ...headerLines] = headerBlock.split('\r\n');
      const [method, path] = (requestLine ?? '').split(' ');
      const headers = parseHeaders(headerLines);
      const contentLength = Number(headers['content-length'] ?? '0');
      const bodyStart = headerEnd + 4;
      const body = buffer.slice(bodyStart, bodyStart + contentLength);

      if (body.length < contentLength) {
        // Body not fully received yet - wait for more data events.
        return;
      }

      requests.push({ method: method ?? '', path: path ?? '', headers, body });

      const status = statusSequence[Math.min(cursor, statusSequence.length - 1)] ?? 200;
      cursor += 1;
      const responseBody = '{}';
      socket.write(
        `HTTP/1.1 ${String(status)} X\r\nContent-Type: application/json\r\nContent-Length: ${String(
          Buffer.byteLength(responseBody),
        )}\r\nConnection: close\r\n\r\n${responseBody}`,
      );
      socket.end();
    });
  });
  server.on('error', () => undefined);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('dispatcher-fixture-server: no AddressInfo'));
        return;
      }
      resolve({
        port: address.port,
        requests,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * A server that never responds (holds the connection open) - used for the
 * per-client in-flight/starvation test. Every accepted socket is tracked and
 * force-destroyed on `close()` - `net.Server#close()` alone only stops
 * accepting NEW connections and waits for existing ones to end on their
 * own, which never happens here by design (the client's own
 * `totalTimeoutMs` ends ITS side of the connection, but the server-side
 * socket can linger past that), so `close()` would otherwise hang past the
 * test's `afterEach` hook timeout.
 */
export function startHangingFixtureServer(): Promise<DispatcherFixtureServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<TLSSocket>();
  const server = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket: TLSSocket) => {
    // Accept the connection, never write a response - the client's own
    // totalTimeoutMs is what eventually ends the attempt.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('error', () => undefined);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('dispatcher-fixture-server: no AddressInfo'));
        return;
      }
      resolve({
        port: address.port,
        requests,
        close: () =>
          new Promise((res, rej) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
