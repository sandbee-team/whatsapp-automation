import { applyDisconnect, type DisconnectBudgetCounters } from '@wp/domain';
import type { CreateSessionRunnerDeps, RunnerSessionState } from './runner-types.js';
import { recordReconnectAttempt } from './metrics.js';

/**
 * runner-disconnect.ts (P08 U5a) - the `connection.update` `{connection:
 * 'close'}` handling and reconnect scheduling, split out of runner.ts to
 * stay under max-lines. `handleClose` is the ONLY place that reads a raw
 * Baileys disconnect code and turns it into a domain `Transition` (via
 * `resolveDisconnect` -> `toFsmRow` -> `applyDisconnect`), then executes the
 * transition's `sideEffects` in order, then decides whether/when to
 * reconnect.
 */

export interface LastDisconnectLike {
  error?: { output?: { statusCode?: number } };
}

export interface HandleCloseDeps {
  deps: CreateSessionRunnerDeps;
  state: RunnerSessionState;
  counters: DisconnectBudgetCounters;
  lastDisconnect: LastDisconnectLike | undefined;
  /** Rebuilds the socket on the SAME lease/store and rewires its events - never re-acquires. */
  reconnectSameLease: () => Promise<void>;
  /** Full teardown including lease release (give-up / non-reconnect terminal paths). */
  teardownWithRelease: () => Promise<void>;
  /**
   * CRITICAL 3 fix - mints (and records, for `teardown()` to abort) a fresh
   * `AbortController` for the reconnect timer's own `connectGate.take()`
   * call, the SAME discipline `start()`'s own deferred-open chain uses. A
   * fresh controller per reconnect attempt so an earlier attempt's abort
   * (already resolved/rejected) never pre-aborts a later one.
   */
  connectGateAbortController: () => AbortController;
}

function extractCode(lastDisconnect: LastDisconnectLike | undefined): number {
  return lastDisconnect?.error?.output?.statusCode ?? 0;
}

/** Runs each side effect in the FIXED order the dispatch specifies - never reordered. */
async function runSideEffects(
  input: HandleCloseDeps,
  sideEffects: readonly string[],
): Promise<void> {
  const { deps, state } = input;

  for (const effect of sideEffects) {
    if (effect === 'audit' || effect === 'notify') {
      // ONE applyEngineTransition call covers both - the U4 service audits
      // transitions out of connected itself; 'notify' has no separate
      // runner-side action (SSE publish is this module's own responsibility,
      // done by the caller after this side-effect loop, not per-effect here).
      continue;
    }
    if (effect === 'purge_auth') {
      await deps.instances.runLoggedOutFlow(state.authStore);
      continue;
    }
    if (effect === 'end_socket') {
      // Routes through the registry handle's own end() (which OWNS the
      // `state.ended` flag via endSocketOnce) rather than setting the flag
      // directly here - setting it directly used to make the LATER
      // registry-handle end() call a silent no-op (endSocketOnce's own
      // `if (state.ended) return;` guard), so the underlying FakeableSocket's
      // `.end()` was never actually invoked and the real Baileys socket
      // leaked on this expected-takeover (440) branch.
      deps.registry.get(state.instanceId)?.end();
      continue;
    }
  }
}

export async function handleClose(input: HandleCloseDeps): Promise<void> {
  const { deps, state, counters, lastDisconnect } = input;
  const code = extractCode(lastDisconnect);
  const { row } = deps.resolveDisconnect(code);
  const fsmRow = deps.toFsmRow(row, state.linkState);

  const expectedTakeover =
    fsmRow.action === 'session_replaced'
      ? await deps.expectedTakeoverCheck(state.instanceId, state.clientId, state.lease.fence)
      : false;

  const fromHealth = state.healthState;
  const transition = applyDisconnect(fsmRow, counters, { expectedTakeover });
  counters.restart515Used = transition.restart515Used;
  counters.unknownAttempts = transition.unknownAttempts;

  await runSideEffects(input, transition.sideEffects);

  await deps.instances.applyEngineTransition(transition, fromHealth, {
    code: code === 0 ? undefined : String(code),
    fence: state.lease.fence,
    workerId: deps.workerId,
  });

  // P16 Unit C fast-lane hook - fires AFTER the FSM's own write has
  // committed, only for a restriction-shaped disconnect. A hook failure
  // must never break the normal disconnect/reconnect flow below (fail-safe:
  // the FSM's own write already landed).
  if (fsmRow.action === 'restriction' && deps.onConnectionUpdate) {
    try {
      await deps.onConnectionUpdate({
        instanceId: state.instanceId,
        clientId: state.clientId,
        disconnectCode: code,
      });
    } catch (err) {
      deps.logger.warn('fast-lane onConnectionUpdate failed', {
        instanceId: state.instanceId,
        clientId: state.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (transition.healthState !== undefined) {
    state.healthState = transition.healthState;
  }
  if (transition.linkState !== undefined) {
    state.linkState = transition.linkState;
  }

  if (transition.sideEffects.includes('notify') || transition.sideEffects.includes('audit')) {
    deps.publish({
      type: 'instance.health_changed',
      clientId: state.clientId,
      instanceId: state.instanceId,
    });
  }

  // Threaded explicitly from the JUST-RESOLVED row/transition (scoped to
  // THIS close), never inferred from the counters' running totals - a 428
  // arriving right after a single 515 leaves the totals unchanged (a 428's
  // own row carries budget=null), so a totals-based inference would misread
  // it as "still restart515" and reconnect at delay 0 (a hot loop).
  // `fsmRow.budget === 'restart515'` alone is not enough either: a 515 row's
  // budget field stays 'restart515' even once its own 2-attempt budget is
  // EXHAUSTED and applyDisconnect has escalated it to the unknown-code path
  // (session-fsm.ts's applyRestart515 -> applyUnknown) - that escalated
  // outcome sets a real healthState ('degraded'/'paused') and must schedule
  // a real backoff delay, not 0. The silent "still within budget" outcome is
  // the ONLY branch that leaves healthState untouched, so both conditions
  // together correctly scope to just this close's actual resolution.
  const isRestart515 = fsmRow.budget === 'restart515' && transition.healthState === undefined;
  await scheduleReconnectOrGiveUp(input, row.autoReconnect, row.baseMultiplier, isRestart515);
}

async function scheduleReconnectOrGiveUp(
  input: HandleCloseDeps,
  autoReconnect: boolean,
  baseMultiplier: number | undefined,
  isRestart515: boolean,
): Promise<void> {
  const { deps, state } = input;

  if (!autoReconnect) {
    return;
  }

  const nextAttempt = state.attempt + 1;
  if (deps.reconnect.shouldGiveUp(nextAttempt)) {
    await deps.instances.applyEngineTransition(
      {
        healthState: 'paused',
        needsUserAction: true,
        userActionReason: 'RECONNECT_FAILED',
        sideEffects: ['audit', 'notify'],
      },
      state.healthState,
      { fence: state.lease.fence, workerId: deps.workerId },
    );
    state.healthState = 'paused';
    deps.publish({
      type: 'instance.health_changed',
      clientId: state.clientId,
      instanceId: state.instanceId,
    });
    await input.teardownWithRelease();
    return;
  }

  state.attempt = nextAttempt;
  const delayMs = isRestart515
    ? 0
    : deps.reconnect.nextDelayMs({
        attempt: state.attempt,
        instanceId: state.instanceId,
        rng: deps.rng,
        baseMultiplier,
      });
  recordReconnectAttempt(
    isRestart515 ? 'restart515' : baseMultiplier !== undefined ? 'multiplied_backoff' : 'backoff',
  );

  state.pendingReconnectTimer = deps.setTimeoutFn(() => {
    void (async () => {
      // FIX (A5): the timer is scheduled synchronously here, but a
      // concurrent teardown (e.g. onFenceLost's teardownNoRelease) can race
      // in the window between handleClose's own earlier awaits and this
      // very assignment - clearPendingReconnect() would find nothing yet
      // assigned to clear. The callback itself re-checks state.ended/
      // tornDown right before doing anything, so a teardown that raced past
      // clearPendingReconnect() still stops this timer from reconnecting on
      // a lease that is no longer safe to use.
      if (state.ended || state.tornDown) {
        return;
      }
      const controller = input.connectGateAbortController();
      try {
        await deps.connectGate.take({ signal: controller.signal });
      } catch {
        // Aborted by a racing teardown (CRITICAL 3), or any other fail-safe
        // connect-gate error - never reconnect on a lease that is no longer
        // safe to use.
        return;
      }
      if (state.ended || state.tornDown) {
        return;
      }
      await input.reconnectSameLease();
    })();
  }, delayMs);
}
