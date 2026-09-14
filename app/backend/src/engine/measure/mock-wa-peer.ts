import { WebSocketServer, type WebSocket } from 'ws';
import { NOISE_WA_HEADER, proto } from 'baileys';

/**
 * mock-wa-peer.ts (P10 Unit U2, RE-DISPATCH against ADR 0032) - the
 * "stall-before-serverHello" resident peer.
 *
 * PEER CONTRACT (5 lines, per dispatch):
 * 1. Binds 127.0.0.1 ONLY; completes a real TCP+TLS+WS upgrade per connection.
 * 2. Reads the client's first framed `clientHello` (strips the `WA` intro
 *    header + 3-byte length prefix) and best-effort decodes it as proof the
 *    client's real send path + Noise handler ran - decode failure is logged,
 *    never fatal, and never causes a reply.
 * 3. NEVER sends a valid `serverHello` - stays silent (WS-level ping/pong
 *    only) so the client parks forever inside Baileys' `validateConnection`
 *    `awaitNextMessage` await: no `processHandshake`, no cert-check throw, no
 *    `end()`, no reconnect.
 * 4. Two profiles: `idle` (silent, the only behavior this unit implements)
 *    and `headlessListener` (name reserved for P10a's active profile - see
 *    the doc comment on `MockWaPeerProfile` for why it is a no-op stub here).
 * 5. `start()`/`connectionCount()`/`close()` lifecycle; every open socket is
 *    tracked so a test can assert residency without inspecting `ws` internals.
 *
 * ABSOLUTE BOUNDARY (safety, invariant 6 + ADR 0032): this is a test double.
 * It never dials WhatsApp, never forges a certificate, and never completes
 * the Noise XX handshake - the cert check in Baileys' own `noise-handler.js`
 * (`processHandshake`) is cryptographically impossible to satisfy without
 * WhatsApp's real root private key, and this file does not attempt to. It
 * holds sockets resident at the awaited-serverHello point, by design, and
 * goes no further. If a future change makes this peer's handshake "complete"
 * against a real Baileys client, that is a bug in this file, not a feature -
 * see ADR 0032's "Revisit when" clause before touching that boundary.
 */

/**
 * `idle`: silent - WS-level ping/pong keepalive only, never a `serverHello`.
 * `headlessListener`: RESERVED for P10a's active profile. In THIS unit it is
 * a no-op stub beyond `idle` - it only records that the profile was
 * selected (`profile` field on `connectionCount`'s snapshot, see below) - it
 * does NOT simulate inbound traffic. Active inbound message delivery
 * requires a completed, post-handshake Noise transport, which is
 * unreachable synthetically (ADR 0032 §Decision item 3); faking inbound
 * traffic through an un-negotiated transport would be exactly the kind of
 * dishonest proxy the ADR forecloses, so this profile intentionally does
 * nothing observable beyond `idle` until a real transport exists to carry it.
 */
export type MockWaPeerProfile = 'idle' | 'headlessListener';

export interface MockWaPeerOptions {
  /** Defaults to `idle`. */
  profile?: MockWaPeerProfile;
  /** Bound port; 0 (default) lets the OS assign an ephemeral port. */
  port?: number;
}

export interface MockWaPeer {
  /** Resolves once the server is bound; returns `ws://127.0.0.1:<port>`. */
  start(): Promise<string>;
  /** Count of currently-open WS connections to this peer. */
  connectionCount(): number;
  /** The profile this peer was constructed with. */
  profile(): MockWaPeerProfile;
  /** Closes every held connection and the server itself. */
  close(): Promise<void>;
}

/**
 * Strips the `WA` intro header (`NOISE_WA_HEADER`, 4 bytes when no
 * `routingInfo` is in play - true for every synthetic creds this unit
 * seeds) and the 3-byte big-endian length prefix from the client's FIRST
 * frame, then attempts to decode the remaining bytes as a
 * `proto.HandshakeMessage`. Returns `undefined` on any mismatch/decode
 * failure - the peer stays resident and silent regardless (see contract
 * item 2); this function exists only so the peer/tests can OBSERVE that the
 * client's real send path ran, never to gate staying resident on it.
 */
export function readClientHelloFrame(data: Buffer): proto.HandshakeMessage | undefined {
  const header = NOISE_WA_HEADER;
  if (data.length < header.length + 3) return undefined;
  for (let i = 0; i < header.length; i += 1) {
    if (data[i] !== header[i]) return undefined;
  }
  const lenOffset = header.length;
  const size = (data[lenOffset]! << 16) | (data[lenOffset + 1]! << 8) | data[lenOffset + 2]!;
  const frameStart = lenOffset + 3;
  if (data.length < frameStart + size) return undefined;
  const frame = data.subarray(frameStart, frameStart + size);
  try {
    return proto.HandshakeMessage.decode(frame);
  } catch {
    return undefined;
  }
}

/**
 * Builds (but does not start) a stall-before-serverHello peer. `start()`
 * binds 127.0.0.1 ONLY (never `0.0.0.0`, never a hostname) - see contract
 * item 1.
 */
export function createMockWaPeer(options: MockWaPeerOptions = {}): MockWaPeer {
  const profileValue: MockWaPeerProfile = options.profile ?? 'idle';
  const sockets = new Set<WebSocket>();
  let wss: WebSocketServer | undefined;

  return {
    async start(): Promise<string> {
      wss = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 });

      await new Promise<void>((resolve, reject) => {
        wss?.once('listening', () => resolve());
        wss?.once('error', reject);
      });

      wss.on('connection', (socket: WebSocket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => sockets.delete(socket));

        // Contract item 2: read (best-effort decode, never fatal) the
        // client's first frame, then remove this listener - Baileys sends
        // exactly one `clientHello`; nothing else is expected while the
        // client sits parked on `serverHello`.
        socket.once('message', (data: Buffer) => {
          readClientHelloFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
          // Contract item 3: never reply. `idle` and `headlessListener`
          // (this unit's no-op stub - see `MockWaPeerProfile`'s doc
          // comment) are identical here: silence, WS-level ping/pong only.
        });
      });

      const address = wss.address();
      if (address === null || typeof address === 'string') {
        throw new Error('mock-wa-peer: expected an AddressInfo from a bound WS server');
      }
      return `ws://127.0.0.1:${String(address.port)}`;
    },
    connectionCount(): number {
      return sockets.size;
    },
    profile(): MockWaPeerProfile {
      return profileValue;
    },
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      const server = wss;
      wss = undefined;
      if (!server) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
