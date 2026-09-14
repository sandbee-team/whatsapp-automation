import net from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTION_CONFIG, initAuthCreds } from 'baileys';
import type { AuthenticationCreds } from 'baileys';
import { logger } from '@wp/server-kit';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { socketFactoryLoggerFrom } from '../session/session-worker-runner-factory.js';
import { createBaileysSocket } from '../../provider/baileys/socket-factory.js';
import { createMockWaPeer, type MockWaPeer } from './mock-wa-peer.js';
import { createMeasureFleet, type MeasureFleet } from './measure-fleet.js';

/**
 * mock-wa-peer.integration.test.ts (P10 Unit U2, RE-DISPATCH against ADR
 * 0032) - the two named tests the ADR's "Wording changes required" section
 * calls for. Kept to a resident window of a few SECONDS (never the ADR's
 * >=20-minute soak - that is the U4 measurement run, not this test).
 */

let handles: StoreTestHandles;
let peer: MockWaPeer;
let peerUrl: string;
let fleet: MeasureFleet | undefined;

beforeAll(async () => {
  handles = createStoreTestHandles();
  peer = createMockWaPeer({ profile: 'idle' });
  peerUrl = await peer.start();
});

afterAll(async () => {
  await peer.close();
  await disposeStoreTestHandles(handles);
});

afterEach(async () => {
  if (fleet) {
    await fleet.teardown();
    await cleanupProbeClients(handles.pool, fleet.clientIds());
    fleet = undefined;
  }
});

describe('mock-wa-peer resident-without-handshake-open', () => {
  it('a_real_baileys_socket_holds_resident_at_awaited_serverhello_without_reconnect', async () => {
    fleet = createMeasureFleet(handles, {
      peerUrl,
      profile: 'idle',
      connectTimeoutMs: 60_000,
    });

    let sawOpen = false;
    let sawCloseOrReconnect = false;

    await fleet.addSessions(1);
    // Reach into the fleet's own bookkeeping is deliberately NOT exposed -
    // instead build one more socket directly, identically to what the
    // fleet does, so this test can attach its own `connection.update`
    // listener without `measure-fleet.ts` growing a test-only event hook.
    // NOTE: this direct build mirrors `measure-fleet.ts#addOneSession`
    // exactly (real creds, real store, real factory, same peer) - kept
    // here rather than added as a seam on `MeasureFleet` because no other
    // caller needs per-session event access (ADR 0032: flat bookkeeping).
    const socketFactoryLogger = socketFactoryLoggerFrom(logger);
    const creds = initAuthCreds() as AuthenticationCreds;
    creds.registered = true;
    creds.me = { id: '15551230001@s.whatsapp.net' };
    const sock = createBaileysSocket({
      auth: { creds, keys: { get: async () => ({}), set: async () => undefined } as never },
      logger: socketFactoryLogger,
      getMessage: async () => undefined,
      waWebSocketUrl: peerUrl,
      connectTimeoutMs: 60_000,
    });
    sock.ev.on('connection.update', (update: { connection?: string }) => {
      if (update.connection === 'open') sawOpen = true;
      if (update.connection === 'close') sawCloseOrReconnect = true;
    });

    // Resident-window observation: a few seconds, never the ADR's soak.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(sawOpen).toBe(false);
    expect(sawCloseOrReconnect).toBe(false);
    expect(peer.connectionCount()).toBeGreaterThanOrEqual(1);

    sock.end(undefined);
    await fleet.teardown();
    expect(fleet.residentCount()).toBe(0);
  });

  it('the_harness_never_dials_a_real_whatsapp_host', async () => {
    // Intercepts at the SOCKET CONNECT layer (`net.Socket.prototype.connect`
    // + `tls.connect`), not at `dns.lookup`/`dns.resolve`. Two reasons, both
    // load-bearing (C1 finding 7):
    //   1. COVERAGE: a DNS-only interceptor misses `dns.promises`,
    //      `dns.lookupService`, an OS/hosts-file or cached resolution, and
    //      anything that connects to a literal IP - all of which would let a
    //      real dial slip past a "green" assertion.
    //   2. NO REAL DIAL: connect-layer interception refuses the connection
    //      BEFORE any packet leaves the box, so the red-proof leg below can
    //      prove the interceptor fires on the real default host WITHOUT this
    //      test ever attempting an outbound connection to WhatsApp from CI.
    // `ws` reaches the network via `net.connect(options)` (empirically
    // verified against ws@8.21.3: it calls the MODULE function `net.connect`,
    // which then delegates to `net.Socket.prototype.connect` with an options
    // object carrying `host`). Patch BOTH the module functions and the
    // prototype so no path escapes: `net.connect`/`net.createConnection` for
    // the plain-ws case, `tls.connect` for wss, and the prototype as the
    // backstop for any caller that constructs its own Socket.
    const seenHosts: string[] = [];
    const originalNetConnect = net.connect;
    const originalNetCreateConnection = net.createConnection;
    const originalProtoConnect = net.Socket.prototype.connect;
    const originalTlsConnect = tls.connect;

    const isRealWhatsAppHost = (hostname: string): boolean =>
      hostname.endsWith('whatsapp.net') || hostname.endsWith('whatsapp.com');

    /** Pulls the target host out of either connect() call shape (options object or (port, host)). */
    const hostFrom = (args: readonly unknown[]): string | undefined => {
      const first = args[0];
      if (typeof first === 'object' && first !== null) {
        const opts = first as { host?: string; hostname?: string };
        return opts.host ?? opts.hostname;
      }
      // (port, host, ...) form: host is the second arg when it is a string.
      return typeof args[1] === 'string' ? args[1] : undefined;
    };

    /** Records the target host and refuses (throws) for a WhatsApp-owned one, before any network I/O. */
    const recordAndGuard = (args: readonly unknown[], api: string): void => {
      const host = hostFrom(args);
      if (host === undefined) return;
      seenHosts.push(host);
      if (isRealWhatsAppHost(host)) {
        throw new Error(
          `mock-wa-peer test interceptor (${api}): refusing to connect to a real WhatsApp host "${host}"`,
        );
      }
    };

    net.connect = ((...args: unknown[]) => {
      recordAndGuard(args, 'net.connect');
      return (originalNetConnect as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof net.connect;

    net.createConnection = ((...args: unknown[]) => {
      recordAndGuard(args, 'net.createConnection');
      return (originalNetCreateConnection as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof net.createConnection;

    net.Socket.prototype.connect = function patchedConnect(
      this: net.Socket,
      ...args: unknown[]
    ): net.Socket {
      recordAndGuard(args, 'net.Socket.prototype.connect');
      return (originalProtoConnect as unknown as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;

    tls.connect = ((...args: unknown[]) => {
      recordAndGuard(args, 'tls.connect');
      return (originalTlsConnect as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof tls.connect;

    try {
      // GREEN LEG: the resident peer path never targets a WhatsApp-owned host.
      fleet = createMeasureFleet(handles, { peerUrl, profile: 'idle', connectTimeoutMs: 5_000 });
      await fleet.addSessions(1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seenHosts.some(isRealWhatsAppHost)).toBe(false);
      // ...and it DID connect somewhere (127.0.0.1), so the green leg is not
      // vacuously true by simply never connecting at all.
      expect(seenHosts.length).toBeGreaterThan(0);
      expect(peer.connectionCount()).toBeGreaterThanOrEqual(1);

      // RED-PROOF LEG: a socket built with the REAL default `waWebSocketUrl`
      // (never overridden) must trip the interceptor. This proves the
      // interceptor actually fires on a real-host dial rather than passing
      // vacuously - and because the interception is at the connect layer, the
      // attempt is refused BEFORE any packet leaves the box (no real outbound
      // connection to WhatsApp is ever made from CI).
      const defaultUrl = (DEFAULT_CONNECTION_CONFIG as { waWebSocketUrl: string }).waWebSocketUrl;
      const defaultHost = new URL(defaultUrl).hostname;
      expect(isRealWhatsAppHost(defaultHost)).toBe(true);

      const socketFactoryLogger = socketFactoryLoggerFrom(logger);
      const creds = initAuthCreds() as AuthenticationCreds;
      const redSock = createBaileysSocket({
        auth: { creds, keys: { get: async () => ({}), set: async () => undefined } as never },
        logger: socketFactoryLogger,
        getMessage: async () => undefined,
        connectTimeoutMs: 3_000,
      });
      await new Promise<void>((resolve) => {
        redSock.ev.on('connection.update', (update: { connection?: string }) => {
          if (update.connection === 'close') resolve();
        });
        setTimeout(resolve, 2_000);
      });
      redSock.end(undefined);

      // The interceptor saw the real host and refused it.
      expect(seenHosts).toContain(defaultHost);
    } finally {
      net.connect = originalNetConnect;
      net.createConnection = originalNetCreateConnection;
      net.Socket.prototype.connect = originalProtoConnect;
      tls.connect = originalTlsConnect;
    }
  });
});
