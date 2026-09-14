import type { SessionInventory, ShedCandidate, ShedPorts } from '../fleet/shed.js';
import type { InFlightPort, DrainSession } from '../fleet/drain.js';
import type { SessionRunnerRegistry } from './registry.js';
import type { LeaseManager, SessionLease } from '../lease/lease-manager.js';

/**
 * fleet-adapters.ts (P09 U6 step 9) - the REAL adapters over the live
 * session registry that `engine/fleet/**`'s pure ports need: `SessionInventory`
 * (shed victim selection), `ShedPorts` (shed execution), and the per-session
 * `DrainSession` list (graceful SIGTERM drain). Lives in `engine/session/**`
 * (not `engine/fleet/**`) specifically so it may safely reach into the
 * runner registry - `engine/fleet/**` modules stay structurally unable to
 * reach anything provider/pairing-shaped (see shed.ts/drain.ts's own
 * SAFETY BOUNDARY doc comments); this file is the sanctioned crossing point,
 * built from ports only (`RunnerHandle.end`/`inventorySnapshot`,
 * `LeaseManager.release`), never a raw Baileys socket or ChannelLink import.
 */

/**
 * `SessionInventory` over the live registry: skips any handle that has not
 * (yet) implemented `inventorySnapshot()` (older/test handles) rather than
 * fabricating zero/null values for it - see `registry.ts`'s own doc comment
 * on `inventorySnapshot`.
 */
export function buildSessionInventory(registry: SessionRunnerRegistry): SessionInventory {
  return {
    snapshot(): ShedCandidate[] {
      const out: ShedCandidate[] = [];
      for (const handle of registry.values()) {
        const snap = handle.inventorySnapshot?.();
        if (!snap) continue;
        out.push({
          instanceId: handle.instanceId,
          clientId: handle.clientId,
          acquiredAtMonotonic: snap.acquiredAtMonotonic,
          inFlightSendCount: snap.inFlightSendCount,
          lastConversationActivityAtMonotonic: snap.lastConversationActivityAtMonotonic,
          queueDepth: snap.queueDepth,
          pairingInProgress: snap.pairingInProgress,
        });
      }
      return out;
    },
  };
}

/**
 * `ShedPorts` over the live registry + `LeaseManager`: `endSocket` =
 * `handle.teardownNoRelease()` (C2 FIX, see below) followed by
 * `registry.delete(instanceId)`; `releaseLeaseGracefully` = `LeaseManager.
 * release`, the SAME graceful, voluntary release path `runner.ts`'s own
 * `teardownWithRelease` uses - never a forced/park path. A shed victim not
 * present in the registry (torn down by something else in the race window
 * between selection and execution), or with no resolvable live lease, is
 * treated as already-gone: both legs become safe no-ops.
 *
 * Takes an explicit `getLease(instanceId)` lookup (the worker's own
 * held-lease bookkeeping - `LeaseHeartbeat.held()`, the one authoritative
 * place, same as `session-worker-composition.ts`'s own `currentFence`
 * helper) so `releaseLeaseGracefully` can call `LeaseManager.release` with
 * the REAL `SessionLease`, never a guessed/zero fence - the registry handle
 * itself does not carry the fence.
 *
 * C2 FIX (fleet-c2-unit.test.ts / fleet-c2.integration.test.ts): the bare
 * `handle.end()` this used to call only ends the socket - it never removes
 * the registry entry, so `session-worker-composition.ts`'s own `grab`
 * callback (`if (registry.has(row.instanceId)) return true;`) treats a shed
 * (and therefore now-unowned) instance as still "owned" by this worker
 * forever, orphaning it. `handle.teardownNoRelease()` gives the same
 * timer-cancelling/idempotent-end discipline the drain path now uses (see
 * `buildDrainSessions` above), and `registry.delete` afterward clears the
 * bookkeeping so this worker can re-grab the instance on a later scan.
 * Deleting the registry entry here is safe even though
 * `releaseLeaseGracefully` runs afterward: that leg resolves the lease via
 * the INJECTED `getLease` closure (the worker's own held-lease map, e.g.
 * `LeaseHeartbeat.held()`), never via the registry - so removing the
 * registry entry first does not affect its ability to find and release the
 * lease.
 */
export function buildShedPortsWithLeaseLookup(
  registry: SessionRunnerRegistry,
  leaseManager: LeaseManager,
  getLease: (instanceId: string) => SessionLease | undefined,
): ShedPorts {
  return {
    async endSocket(instanceId: string): Promise<void> {
      const handle = registry.get(instanceId);
      if (!handle) return;
      // The delete must survive a throwing socket end: shed's release leg
      // still runs afterwards (ShedResult.releaseOk), so leaving the entry
      // behind would recreate the zombie state on the throw path - the
      // now-unowned instance would read as "owned" to grab() forever.
      try {
        await handle.teardownNoRelease();
      } finally {
        registry.delete(instanceId);
      }
    },
    async releaseLeaseGracefully(instanceId: string): Promise<void> {
      const lease = getLease(instanceId);
      if (!lease) return;
      await leaseManager.release(lease);
    },
  };
}

/**
 * `DrainSession[]` snapshot over the live registry, for `createDrain`'s
 * `sessions` port: `flushCreds` = the runner's own auth-store flush hook
 * (the registry handle does not expose the auth store directly, so this
 * takes an injected `flushCredsFor(instanceId)` closure the composition
 * wires to the SAME `EncryptedAuthStore` instance the runner built - see
 * wiring for how that closure is captured per-session), `endSocket` =
 * `handle.teardownNoRelease()` (CRITICAL 1 FIX - see below), `releaseLease`
 * = `handle.teardownWithRelease()` MINUS the socket-end half (drain's own
 * sequence already calls endSocket separately) - so this uses
 * `leaseManager.release` directly via the same `getLease` lookup
 * `buildShedPortsWithLeaseLookup` uses, never `teardownWithRelease` itself
 * (which would double-end the socket).
 *
 * CRITICAL 1 FIX (C1 review): `endSocket` used to call the bare
 * `handle.end()`, which only ends the underlying socket - it does NOT set
 * `state.tornDown` and does NOT clear the runner's pending grace/connect-
 * offset timers (see runner.ts's `teardown()`). A DrainSession executed
 * while one of those deferred waits is still parked (or while an in-flight
 * reconnect timer is armed - `buildAndWireSocket` resets `state.ended =
 * false` on every call) could therefore have its socket rebuilt AFTER
 * drain already released the lease via `releaseLease` below: split-brain,
 * two processes believing they own the same lease. `handle.
 * teardownNoRelease()` sets `tornDown`, clears both timers, and ends the
 * socket idempotently via the runner's own `endSocketOnce` - called BEFORE
 * `releaseLease` so no deferred/reconnect path can win the race.
 */
export function buildDrainSessions(
  registry: SessionRunnerRegistry,
  leaseManager: LeaseManager,
  getLease: (instanceId: string) => SessionLease | undefined,
  flushCredsFor: (instanceId: string) => Promise<void>,
): DrainSession[] {
  const sessions: DrainSession[] = [];
  for (const handle of registry.values()) {
    sessions.push({
      instanceId: handle.instanceId,
      flushCreds: () => flushCredsFor(handle.instanceId),
      endSocket: () => {
        void handle.teardownNoRelease();
      },
      releaseLease: async () => {
        const lease = getLease(handle.instanceId);
        if (!lease) return;
        await leaseManager.release(lease);
      },
    });
  }
  return sessions;
}

/** Trivial `InFlightPort` stub (P11 provides the real in-flight-send tracker) - always empty/instantly quiescent, matching the drain dispatch's own documented stub position. */
export function buildEmptyInFlightPort(): InFlightPort {
  return {
    list: () => [],
    awaitQuiescence: async () => undefined,
  };
}
