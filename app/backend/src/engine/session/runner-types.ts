import type { Transition, WaHealth, WaLinkState } from '@wp/domain';
import type { PairingController, PairingSocketHandle, QrPublishEvent } from './pairing.js';
import type { ConnectGate } from './connect-gate.js';
import type { RunnerHandle, SessionRunnerRegistry } from './registry.js';
import type { SessionOwner } from '../lease/session-owner.port.js';
import type { DisconnectPolicyRow } from '../../provider/baileys/disconnect-map.js';
import type { DisconnectPolicyRowLike } from '@wp/domain';

/**
 * runner-types.ts (P08 U5a) - `createSessionRunner`'s injected-dependency
 * surface, split out of runner.ts to stay under max-lines. ALL I/O is
 * injected - see this file for the exact shape every fake in runner.test.ts must implement.
 */

export interface FakeableSocket {
  ev: {
    /** `'messages.upsert'` (P12 U3), `'messages.update'` / `'message-receipt.update'` (P21 U6b) - each callback receives the raw Baileys event shape, untyped here (no Baileys import in this file); `runner.ts` passes it straight through to the matching `deps.onX` without inspecting it. */
    on(
      ev:
        | 'connection.update'
        | 'creds.update'
        | 'messages.upsert'
        | 'messages.update'
        | 'message-receipt.update',
      cb: (u: unknown) => void,
    ): void;
  };
  end(err?: Error): void;
  requestPairingCode?(phone: string): Promise<string>;
  user?: { id: string };
  /**
   * Optional (P12 U0) - matches `BaileysSendSocketPort.sendMessage`'s
   * signature so the real Baileys socket satisfies this interface without a
   * cast. Every existing fake in the test suite predates this field and
   * still type-checks unchanged: `runner.ts` only reads it via
   * `currentSock?.sendMessage`, never assumes it is present.
   */
  sendMessage?(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ id?: string | null } | undefined>;
  /**
   * Optional (P24 Unit U3, step 4/5) - matches
   * `BaileysGroupSocketPort.groupFetchAllParticipating`'s signature so the
   * real Baileys socket satisfies this interface without a cast. Every
   * existing fake predates this field and still type-checks unchanged.
   */
  groupFetchAllParticipating?(): Promise<
    Record<
      string,
      {
        id: string;
        subject?: string;
        participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }>;
        announce?: boolean;
        creation?: number;
      }
    >
  >;
  /** Optional (P24 Unit U3, step 5) - matches `BaileysGroupSocketPort.groupLeave`'s signature. */
  groupLeave?(jid: string): Promise<void>;
  /**
   * Optional (2026-09-22, "device paused" presence fix, Task 2) - matches
   * Baileys' own `sendPresenceUpdate(type: WAPresence, toJid?: string):
   * Promise<void>` signature (the real socket's `toJid` is never passed by
   * this codebase's one caller, `onOpen` in `runner-connection-update.ts`,
   * so it is omitted here rather than widening this fake surface for an
   * argument nothing uses). Every existing fake in the test suite predates
   * this field and still type-checks unchanged - `runner-connection-
   * update.ts` only calls it via `sock.sendPresenceUpdate?.(...)`, never
   * assumes it is present.
   */
  sendPresenceUpdate?(type: 'unavailable'): Promise<void>;
}

export interface SessionLeaseLike {
  instanceId: string;
  clientId: string;
  fence: bigint;
  workerId: string;
  /** P09 fleet-recovery FIX - see `lease-manager.types.ts`'s `SessionLease.graceMs` doc comment. The runner waits this out, deferred/cancellable, before its first `buildAndWireSocket()` call. */
  graceMs: number;
}

export interface LeaseManagerPort {
  acquire(input: { instanceId: string; clientId: string }): Promise<SessionLeaseLike | null>;
  release(lease: SessionLeaseLike): Promise<void>;
}

export interface HeartbeatPort {
  add(lease: SessionLeaseLike): void;
  remove(instanceId: string): void;
}

export type {
  AuthStoreIdentityLike,
  AuthStorePortsLike,
  AuthStoreLike,
  CredsSaveBufferPort,
  BuildAuthStoreResult,
  BuildAuthStoreFn,
} from './runner-auth-store-types.js';
import type { AuthStoreLike, BuildAuthStoreFn } from './runner-auth-store-types.js';

export interface RunnerInstancesPort {
  applyEngineTransition(
    transition: Transition,
    fromHealth: WaHealth,
    meta: { code?: string; reasonLabel?: string; fence: bigint | number; workerId: string },
  ): Promise<void>;
  runLoggedOutFlow(authStore: AuthStoreLike): Promise<void>;
  markLinkedConnected(input: { ownerJid: string | null; phoneE164: string | null }): Promise<void>;
  readSessionEpoch(
    instanceId: string,
    clientId: string,
  ): Promise<{ sessionEpoch: number; healthState: string; linkState: string }>;
}

export type RunnerPublish = (
  event: QrPublishEvent | { type: 'instance.health_changed'; clientId: string; instanceId: string },
) => void;

export interface ReconnectPolicyPort {
  nextDelayMs(input: {
    attempt: number;
    instanceId: string;
    rng: { random(): number };
    baseMultiplier?: number;
  }): number;
  shouldGiveUp(attempt: number): boolean;
  onOpen(input: { openedAtMs: number; closedAtMs: number; attempt: number }): number;
}

export interface RunnerClock {
  now(): number;
}

export interface RunnerLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CreateSessionRunnerDeps {
  leaseManager: LeaseManagerPort;
  heartbeat: HeartbeatPort;
  buildAuthStore: BuildAuthStoreFn;
  socketFactory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  instances: RunnerInstancesPort;
  pairing: PairingController;
  connectGate: ConnectGate;
  publish: RunnerPublish;
  resolveDisconnect: (code: number) => { row: DisconnectPolicyRow; mapped: boolean };
  toFsmRow: (row: DisconnectPolicyRow, currentLinkState: WaLinkState) => DisconnectPolicyRowLike;
  reconnect: ReconnectPolicyPort;
  rng: { random(): number };
  clock: RunnerClock;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  logger: RunnerLogger;
  workerId: string;
  env: string;
  expectedTakeoverCheck: (
    instanceId: string,
    clientId: string,
    myFence: bigint,
  ) => Promise<boolean>;
  registry: SessionRunnerRegistry;
  sessionOwner: SessionOwner;
  /** Optional (P12 U3) - subscribed to `sock.ev.on('messages.upsert', ...)` on every socket build/rebuild when present; omitted entirely (never called) if not supplied, so every runner test that predates echo capture is unaffected. Never throws past `runner.ts`'s own boundary - see `session-worker-runner-factory.ts`'s wiring for the try/catch that owns that guarantee. */
  onMessagesUpsert?: (payload: unknown) => void;
  /** Optional (P21 U6b) - subscribed to `sock.ev.on('messages.update', ...)` alongside `onMessagesUpsert`; omitted means no listener is registered (same fail-safe default). */
  onMessagesUpdate?: (payload: unknown) => void;
  /** Optional (P21 U6b) - subscribed to `sock.ev.on('message-receipt.update', ...)` alongside `onMessagesUpsert`; omitted means no listener is registered (same fail-safe default). */
  onMessageReceiptUpdate?: (payload: unknown) => void;
  /**
   * Optional (P16 Unit C) - the health fast-lane hook: called from
   * `runner-disconnect.ts#handleClose` with the raw disconnect code whenever
   * `toFsmRow`'s resolved `action === 'restriction'` (403/402/406-shaped),
   * so a hard-restriction pause lands within the SAME tick as the socket
   * close, never waiting for the next 5-minute evaluator sweep. Omitted
   * entirely (never called) if not supplied - every existing runner test
   * that predates this hook is unaffected. A rejection here is caught by
   * the caller and never allowed to break the normal disconnect/reconnect
   * flow (fail-safe: a fast-lane hiccup must never block the FSM's own
   * write).
   */
  onConnectionUpdate?: (input: {
    instanceId: string;
    clientId: string;
    disconnectCode: number;
  }) => Promise<void>;
}

export interface StartInput {
  instanceId: string;
  clientId: string;
  method?: 'qr' | 'code';
  phone?: string;
  /**
   * P09 U6b: `true` when the discovery/grab cycle that is starting this
   * instance has more pending connects this cycle than
   * `DEFAULT_PER_WORKER_BURST` (a connect-STORM wave, not a single user-
   * initiated (re)connect) - see runner.ts's own wait-site comment for how
   * this composes with `linkState` to decide the connect-offset wait.
   * Defaults to `false` (never offset) when omitted, e.g. every existing
   * test/call site that predates this field.
   */
  waveConnect?: boolean;
}

export type StartResult = 'not_acquired' | RunnerHandle;

/** Internal, per-session mutable state the runner tracks across reconnects (never exposed outside this module). */
export interface RunnerSessionState {
  instanceId: string;
  clientId: string;
  lease: SessionLeaseLike;
  authStore: AuthStoreLike;
  healthState: WaHealth;
  linkState: WaLinkState;
  attempt: number;
  openedAtMs: number | null;
  pendingReconnectTimer: unknown;
  /**
   * P09 U6b: the connect-offset wait timer scheduled between `readSessionEpoch`
   * and the FIRST `buildAndWireSocket()` call, when `linkState === 'linked'
   * && waveConnect`. Cleared by `teardown()` exactly like
   * `pendingReconnectTimer` - a torn-down/drained session must never open a
   * socket after this timer's delay elapses.
   */
  pendingOffsetTimer: unknown;
  sessionEpoch: number;
  /** FIX-A (P26 C1 review, CRITICAL 1): the auth store's OWN `cred_version` - never `sessionEpoch`, a different quantity. Seeded `0n` (the store's documented first-save sentinel) and set from every successful `saveCreds`' resolved version, so the next save's `expectedVersion` always targets the fast (non-conflict) path. */
  credVersion: bigint;
  ended: boolean;
  /**
   * Bumped once per successful `buildAndWireSocket` call (P08 E3 FIX 1/2).
   * Every `connection.update` handler closes over the generation that was
   * current when its listener was registered - a duplicate/stray event
   * whose generation no longer matches `state.sockGeneration`, or that
   * arrives for a generation already being torn down, is ignored as a safe
   * no-op instead of re-running side effects or writing state.
   */
  sockGeneration: number;
  /** Set true while a 'close' for the CURRENT generation is being handled - the single-flight guard for FIX 1. */
  closeInFlightGeneration: number | undefined;
  /**
   * Set to `true` BEFORE the `leaseManager.release` await (P08 FIX BATCH A,
   * A4) - guards against two teardown callers racing (e.g. a give-up
   * branch's `teardownWithRelease` and a concurrent caller reaching the same
   * handle) both releasing the SAME lease. `registry.delete` alone does not
   * stop a closure that already holds a reference to `teardown`; a second
   * release could clobber a NEW owner's fresh lease row acquired in the
   * window between the two calls.
   */
  releasedLease: boolean;
  /**
   * Set to `true` at the very start of `teardown()` (P08 FIX BATCH A, A5) -
   * a pending reconnect timer's own callback checks this (alongside
   * `state.ended`) BEFORE calling `connectGate.take()`/`reconnectSameLease`,
   * because the timer is scheduled synchronously but a `teardownNoRelease()`
   * racing in the window between `handleClose`'s own earlier awaits and the
   * `state.pendingReconnectTimer =` assignment would find nothing yet
   * assigned to clear - the timer would otherwise still fire later and
   * rebuild a socket on an already-lost fence.
   */
  tornDown: boolean;
}

export type { PairingSocketHandle };
