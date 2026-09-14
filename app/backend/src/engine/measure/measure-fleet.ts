import { initAuthCreds } from 'baileys';
import type { AuthenticationCreds } from 'baileys';
import { logger } from '@wp/server-kit';
import { socketFactoryLoggerFrom } from '../session/session-worker-runner-factory.js';
import { createBaileysSocket } from '../../provider/baileys/socket-factory.js';
import {
  buildStore,
  seedTenantInstanceAndLease,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import type { MockWaPeerProfile } from './mock-wa-peer.js';

/**
 * measure-fleet.ts (P10 Unit U2, RE-DISPATCH against ADR 0032) -
 * `createMeasureFleet`: stands up N REAL Baileys sockets, through the REAL
 * production `createBaileysSocket` factory and the REAL `EncryptedAuthStore`
 * + bounded Signal key store, against a local `mock-wa-peer.ts` instance -
 * never a parallel/fake socket path. Each session's creds are seeded
 * REGISTERED (`initAuthCreds()` + `registered:true` + a fake `me` jid) so
 * the socket takes the login branch and actually attempts to connect,
 * exercising the full object graph + real TCP/TLS/WS transport.
 *
 * SAFETY BOUNDARY (invariant 6 + ADR 0032): every session here points at the
 * CALLER-supplied `peerUrl` (a local `mock-wa-peer.ts` instance in every
 * caller this repo ships) via `waWebSocketUrl`, never Baileys' own
 * production default - see `socket-factory.ts`'s `waWebSocketUrl` override
 * doc comment. This module builds no DNS/network policy of its own; the
 * override is plain data passed to the real factory.
 *
 * Per-session bookkeeping is a flat array of small handles (socket + a
 * cheap boolean read of `ws`'s own `readyState`) - deliberately NOT a
 * bigger tracking structure, so this harness does not distort the very RSS
 * slope it exists to help measure (ADR 0032 §"per-session bookkeeping...
 * flat").
 */

export interface MeasureFleetOptions {
  /** The local `mock-wa-peer.ts` URL (`ws://127.0.0.1:<port>`) every session dials instead of the real WhatsApp endpoint. */
  peerUrl: string;
  /** Which peer profile the fleet is measuring against - carried for the published artifact header only; this module's own behavior does not branch on it. */
  profile?: MockWaPeerProfile;
  /**
   * Raised well past Baileys' 20s default (ADR 0032: "the connect timeout
   * must be raised... so the awaited-serverHello state does not itself time
   * out and tear down during the >=20-minute soak"). Defaults to 30 minutes.
   */
  connectTimeoutMs?: number;
  /** Baileys' own QR-wait timeout - same raise-it rationale as `connectTimeoutMs`. Defaults to 30 minutes. */
  qrTimeoutMs?: number;
}

export interface MeasureFleetSession {
  instanceId: string;
  clientId: string;
  sock: ReturnType<typeof createBaileysSocket>;
}

export interface MeasureFleet {
  /** Builds `n` more real sockets against the configured peer, seeding fresh registered creds for each. */
  addSessions(n: number): Promise<void>;
  /** Total sessions built so far (never decremented by residency loss - see `residentCount()`). */
  sessionCount(): number;
  /**
   * Count of sessions whose underlying WS socket is CURRENTLY alive
   * (`readyState === OPEN`) - a session that closed/errored (therefore
   * entered Baileys' reconnect backoff) drops out of this count without
   * being removed from `sessionCount()`'s total, so a caller can detect "the
   * resident population degraded mid-ramp" and void that ramp point (ADR
   * 0032: "if a timeout fires... the ramp point is void, never silently
   * thinned").
   */
  residentCount(): number;
  /** Runs `global.gc()` if the process was started with `--expose-gc`; a no-op otherwise (guarded, never throws). */
  forceGc(): void;
  /** Ends every held socket. Auth-store/DB/Redis handle lifecycle stays the CALLER's (this module never owns `handles`). */
  teardown(): Promise<void>;
  /** Every `clientId` this fleet has seeded so far - a test's `afterEach` passes this straight to `cleanupProbeClients`. */
  clientIds(): string[];
}

const DEFAULT_LONG_TIMEOUT_MS = 30 * 60 * 1000;

/** A fake `me` jid - never a real WhatsApp number (safety boundary). */
function fakeMeJid(instanceId: string): string {
  // A syntactically-valid-shaped jid built from a random UUID's digits -
  // never a real, dialable phone number.
  const digits = instanceId
    .replace(/[^0-9]/g, '')
    .padEnd(11, '0')
    .slice(0, 11);
  return `1${digits}@s.whatsapp.net`;
}

/** Seeds fresh REGISTERED creds (login branch, not the pairing/QR branch) for one synthetic session. */
function seedRegisteredCreds(instanceId: string): AuthenticationCreds {
  const creds = initAuthCreds() as AuthenticationCreds;
  creds.registered = true;
  creds.me = { id: fakeMeJid(instanceId) };
  return creds;
}

export function createMeasureFleet(
  handles: StoreTestHandles,
  options: MeasureFleetOptions,
): MeasureFleet {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  const qrTimeoutMs = options.qrTimeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  const socketFactoryLogger = socketFactoryLoggerFrom(logger);
  const sessions: MeasureFleetSession[] = [];
  // Kept separately from `sessions` (never cleared by `teardown()`) so a
  // test's `afterEach` can still purge every seeded `clients` row AFTER
  // `teardown()` has already ended every socket.
  const seededClientIds: string[] = [];

  async function addOneSession(): Promise<void> {
    // `whatsapp_session_credentials.instance_id` FK-references
    // `whatsapp_instances(id)` (db/migrations/0020_session_auth_state.sql) -
    // `seedTenantInstanceAndLease` gives us a real `clients` +
    // `whatsapp_instances` + `instance_lease_state` row set at fence 0; the
    // lease row itself is unused by this measurement (no worker ever claims
    // it), but seeding it is the cheapest way to satisfy the FK through the
    // repo's own existing fixture rather than hand-rolling a second insert
    // path here.
    const fence = 0n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    const creds = seedRegisteredCreds(instanceId);

    // Real `EncryptedAuthStore` (P07) - same idiom as
    // store-round-trip.integration.test.ts: `buildStore` over the shared
    // handles, `saveCreds` through the real codec/PG path.
    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds, expectedVersion: 0n, fence });

    const sock = createBaileysSocket({
      auth: { creds, keys: store.asSignalKeyStore() },
      logger: socketFactoryLogger,
      getMessage: async () => undefined,
      waWebSocketUrl: options.peerUrl,
      connectTimeoutMs,
    });
    // qrTimeout is set by `buildSocketConfig` itself (45_000 default) - the
    // registered-creds login branch never reaches the QR-eligible path, so
    // this fleet does not need to override it per-session; `qrTimeoutMs` is
    // accepted on `MeasureFleetOptions` for callers that seed unregistered
    // creds in a future unit, and is intentionally unused while every
    // session here is pre-registered.
    void qrTimeoutMs;

    sessions.push({ instanceId, clientId, sock });
    seededClientIds.push(clientId);
  }

  return {
    async addSessions(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        await addOneSession();
      }
    },
    sessionCount(): number {
      return sessions.length;
    },
    residentCount(): number {
      let count = 0;
      for (const session of sessions) {
        const ws = (session.sock as unknown as { ws?: { isOpen?: boolean } }).ws;
        if (ws?.isOpen) count += 1;
      }
      return count;
    },
    forceGc(): void {
      const gc = (global as unknown as { gc?: () => void }).gc;
      gc?.();
    },
    async teardown(): Promise<void> {
      for (const session of sessions) {
        try {
          (session.sock as unknown as { end: (err?: Error) => void }).end();
        } catch {
          // best-effort - a session already torn down (e.g. the peer closed
          // first) must not block tearing down the rest.
        }
      }
      sessions.length = 0;
    },
    clientIds(): string[] {
      return [...seededClientIds];
    },
  };
}
