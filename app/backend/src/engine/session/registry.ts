import type { FenceLostCause, SessionOwner } from '../lease/session-owner.port.js';
import type {
  BaileysSendSocketPort,
  BaileysGroupSocketPort,
} from '../../provider/baileys/adapter.js';

/**
 * registry.ts (P08 U5a) - `RunnerHandle`'s process-local cache, keyed by
 * `instanceId`. This is a CACHE OF LEASED RESOURCES this worker process is
 * actively running a socket for - it is NOT an ownership arbiter (that is
 * `instance_lease_state` + the Redis lease key, both external to this
 * process). A worker restart loses this map entirely and that is fine: the
 * lease/fence machinery is the source of truth for who owns what, never this
 * `Map`.
 */

/** Everything the runner keeps about one live (or reconnecting) session. */
export interface RunnerHandle {
  instanceId: string;
  clientId: string;
  /** Ends the underlying socket without touching the lease - `stop`/`teardownNoRelease` call this directly. */
  end(err?: Error): void;
  /** Tears down without releasing the lease (fence already lost elsewhere) - `SessionOwner.onFenceLost`'s handler. */
  teardownNoRelease(): Promise<void>;
  /** Full teardown INCLUDING lease release - the pairing-exhaustion / give-up paths. */
  teardownWithRelease(): Promise<void>;
  /**
   * Optional accessor for the live Baileys socket, if this runner currently
   * has one open (P08 U6a). Only `provider/baileys/adapter.ts#unlink` may
   * call `.logout()` on the object this returns - see
   * `logout-call-sites.test.ts`'s allow-list. Absent/`undefined` (no live
   * socket, or a runner implementation that predates U6a) means "nothing to
   * log out" - callers must treat that as legal, not an error.
   */
  getSock?(): { logout(): Promise<void> } | undefined;
  /**
   * Optional accessor for a SEND-CAPABLE view of the live socket (P12 U0) -
   * deliberately a SEPARATE, narrower port from `getSock` above, never a
   * widening of it: `getSock`'s return type stays scoped to `unlink`'s
   * single legal `.logout()` call site (`logout-call-sites.test.ts`'s
   * allow-list), and this accessor never exposes `.logout()` at all. Must
   * return `undefined` whenever it is not safe to send - no live socket, the
   * session ended/torn down, or the connection has not yet reported open -
   * so the queue engine's fail-closed `not_connected` path (core invariant
   * 2) is the only outcome for every state short of a genuinely open,
   * healthy connection.
   */
  getSendSocket?(): BaileysSendSocketPort | undefined;
  /**
   * Optional accessor for a GROUP-sync-capable view of the live socket (P24
   * Unit U3, step 4/5) - same fail-closed shape as `getSendSocket` (connected
   * + linked + live), a SEPARATE narrow port (`BaileysGroupSocketPort`,
   * `provider/baileys/adapter.ts`) exposing only
   * `groupFetchAllParticipating`/`groupLeave`/`selfJid` - never the raw
   * socket, never `.logout()`, never any participant-management method.
   * `undefined` means "not safe to touch groups right now" - the caller
   * (`session-groups-sync-timer.ts`) skips that instance's sync/leave for
   * this tick rather than guessing.
   */
  getGroupSocket?(): BaileysGroupSocketPort | undefined;
  /**
   * Optional fleet-inventory snapshot (P09 U6 step 9) - `engine/fleet/
   * shed.ts`'s `ShedCandidate` shape, minus `instanceId`/`clientId` (the
   * caller already has both from this same handle). Absent/`undefined`
   * (a runner implementation that predates this field) means the fleet
   * inventory adapter should skip this handle entirely rather than guess -
   * never fabricate zero/null values for a handle that cannot report them.
   */
  inventorySnapshot?(): {
    acquiredAtMonotonic: number;
    inFlightSendCount: number;
    lastConversationActivityAtMonotonic: number | null;
    queueDepth: number;
    pairingInProgress: boolean;
  };
}

export type SessionRunnerRegistry = Map<string, RunnerHandle>;

export function createSessionRegistry(): SessionRunnerRegistry {
  return new Map();
}

/**
 * Builds the P06 `SessionOwner` port bound to `registry`. `onFenceLost`
 * (heartbeat's self-fence path) tears down WITHOUT release - core invariant
 * 2/fail-safe: a lease this process no longer holds must never be released
 * again by this process (nothing to release; a double-release could clobber
 * a NEW owner's fresh lease row). `close` (LeaseManager.release's own step 1)
 * ends the socket only - the caller (LeaseManager.release) does the actual
 * Postgres/Redis release itself, right after this returns.
 */
export function createSessionOwner(registry: SessionRunnerRegistry): SessionOwner {
  return {
    onFenceLost(instanceId: string, cause: FenceLostCause): void {
      const handle = registry.get(instanceId);
      if (!handle) {
        return;
      }
      // `cause` is not branched on here - every self-fence cause tears down
      // the SAME way (no release); callers that need the cause for metrics
      // read it from `heartbeat.ts`'s own `incrementLeaseLost(cause)` call,
      // not from this port.
      void cause;
      // Fire-and-forget: `SessionOwner.onFenceLost` is a synchronous port
      // (heartbeat.ts calls it without awaiting) - the teardown itself may
      // be async (ending a socket, clearing timers), so it is intentionally
      // not awaited here.
      void handle.teardownNoRelease();
    },
    close(instanceId: string): void {
      const handle = registry.get(instanceId);
      if (!handle) {
        return;
      }
      handle.end();
    },
  };
}
