import type { TenantQueryable } from '@wp/db';

/**
 * drain.ts (P09 Unit U4, step 7) - graceful SIGTERM drain machinery
 * (`stop_grace_period >= 45s` on the deploy side): stop grabbing -> stop
 * claiming -> wait <=20s for in-flight sends (anything still in flight ->
 * `needs_reconcile`, never a blind retry) -> flush creds -> end every
 * socket -> release every lease -> close pools -> exit 0.
 *
 * SAFETY BOUNDARY: same class as `shed.ts` - this module only ever calls
 * INJECTED ports (`endSocket`/`releaseLease`/`flushCreds`), never a pairing
 * controller or ChannelLink. `endSocket` is `sock.end()`, never `logout()`.
 *
 * Signal registration itself (SIGTERM/SIGINT handlers) happens in the
 * wiring unit, NOT here - this file only exports the machinery.
 */

// ---------------------------------------------------------------------
// deployWaveSize - runbook consumer.
// ---------------------------------------------------------------------

/**
 * `max(1, floor(fleetSessions * 0.02 / sessionsPerWorker))` - canon: at 10k
 * fleet sessions with 135 sessions/worker, this is exactly 1 worker per
 * wave.
 */
export function deployWaveSize(fleetSessions: number, sessionsPerWorker: number): number {
  return Math.max(1, Math.floor((fleetSessions * 0.02) / sessionsPerWorker));
}

// ---------------------------------------------------------------------
// markNeedsReconcile - the real DB write, exported for wiring to use as
// the `markNeedsReconcile` port directly.
// ---------------------------------------------------------------------

export interface MarkNeedsReconcileInput {
  jobId: string;
  instanceId: string;
  clientId: string;
}

/**
 * CONDITIONAL, IDEMPOTENT transition to `needs_reconcile`. Predicated on
 * `status = 'processing'` (the only state a genuinely in-flight-at-drain-time
 * job can be in - `claim-jobs.sql` is the only statement that sets
 * `processing`, and this job was claimed and never finished) - so this
 * statement:
 *
 *   - NEVER requeues (does not touch `queued`/`created` rows - those were
 *     never claimed, nothing to reconcile).
 *   - NEVER fails on a lost race (a job that already moved to `sent`/
 *     `failed`/`cancelled`/`needs_reconcile`/etc by the time this runs
 *     matches zero rows - a normal, successful no-op, not an error).
 *   - NEVER touches a job already terminal (the `WHERE status = 'processing'`
 *     predicate excludes every terminal status by construction).
 *   - WARNING FIX 6: NEVER touches a job re-claimed by a DIFFERENT instance
 *     between drain's in-flight snapshot and this write - `instance_id = $3`
 *     is now part of the predicate (tenant isolation, core invariant 4): a
 *     job id that somehow matches this tenant/status but a different
 *     instance is a zero-row no-op, never silently reconciled under the
 *     wrong instance's accounting.
 *
 * Runs through the caller's own `tx: TenantQueryable` (already
 * `app.client_id`-scoped by `TenantDb.withTenant`) - this function opens no
 * connection or transaction of its own.
 */
export async function markNeedsReconcile(
  tx: TenantQueryable,
  input: MarkNeedsReconcileInput,
): Promise<void> {
  await tx.query(
    `UPDATE message_jobs SET status = 'needs_reconcile', updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'processing' AND instance_id = $3`,
    [input.jobId, input.clientId, input.instanceId],
  );
}

// ---------------------------------------------------------------------
// createDrain - the fixed sequence.
// ---------------------------------------------------------------------

export interface InFlightEntry {
  jobId: string;
  instanceId: string;
  clientId: string;
}

export interface InFlightPort {
  list(): InFlightEntry[];
  awaitQuiescence(deadlineMs: number): Promise<void>;
}

export interface DrainSession {
  instanceId: string;
  flushCreds(): Promise<void>;
  endSocket(): void;
  releaseLease(): Promise<void>;
}

export interface DrainDeadlines {
  inFlightWaitMs: number;
  totalMs: number;
}

/** Injectable defaults - CANON, do not change: `inFlightWaitMs: 20_000, totalMs: 45_000`. */
export const DEFAULT_DRAIN_DEADLINES: DrainDeadlines = {
  inFlightWaitMs: 20_000,
  totalMs: 45_000,
};

export interface DrainLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: DrainLogger = { error: () => undefined };

export interface DrainDeps {
  /** Flips the admission controller - `admission.ts`'s `beginDrain()`. */
  beginDrain(): void;
  /** Claim loop is a later phase; wiring passes a no-op today - the SEQUENCE POSITION must exist. */
  stopClaiming(): Promise<void>;
  inFlight: InFlightPort;
  /** The real DB write is `markNeedsReconcile` above; wiring binds it to a `tx`. Injected here so this function stays pure/testable. */
  markNeedsReconcile(job: InFlightEntry): Promise<void>;
  sessions: DrainSession[];
  closePools(): Promise<void>;
  /** NEVER call `process.exit` directly - always through this port. */
  exit(code: number): void;
  deadlines?: DrainDeadlines;
  logger?: DrainLogger;
}

/**
 * Runs `fn`, but never lets it push the caller past `budgetMs` remaining:
 * races `fn` against a timer. A hung `fn` is abandoned (best-effort skip +
 * log) rather than awaited forever - the drain must still reach `exit`
 * within `totalMs` even when a port hangs.
 */
async function withBudget(
  fn: () => Promise<void>,
  budgetMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      resolve();
    }, budgetMs);
  });

  try {
    await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  // If fn() rejected AFTER the timeout already fired, swallow it here -
  // the caller has already moved on and logged the timeout; an unhandled
  // rejection surfacing later must not crash the drain.
  if (timedOut) {
    return;
  }
}

export function createDrain(deps: DrainDeps): { run(): Promise<void> } {
  const deadlines = deps.deadlines ?? DEFAULT_DRAIN_DEADLINES;
  const logger = deps.logger ?? NOOP_LOGGER;

  return {
    async run(): Promise<void> {
      const startedAt = Date.now();
      const remainingMs = (): number => Math.max(0, deadlines.totalMs - (Date.now() - startedAt));

      // 1. beginDrain - flips admission, stops new leases being grabbed.
      deps.beginDrain();

      // 2. stopClaiming - claim loop sequence position (no-op today).
      await deps.stopClaiming();

      // 3. awaitQuiescence(<=20s) - wait for in-flight sends, budget-capped
      // so a hung port cannot exceed inFlightWaitMs (and transitively
      // totalMs). C1 FINDING 3b: the EFFECTIVE budget (the min of
      // inFlightWaitMs and whatever total time is actually left) is computed
      // ONCE and passed into BOTH withBudget's timer AND the port's own
      // deadline - passing the raw inFlightWaitMs to the port while
      // withBudget races a shorter timer let withBudget abandon the promise
      // first, leaving the query running detached; `lastSeen` could then be
      // assigned AFTER `list()` was already read, silently losing the mark.
      const inFlightBudget = Math.min(deadlines.inFlightWaitMs, remainingMs());
      await withBudget(
        () => deps.inFlight.awaitQuiescence(inFlightBudget),
        inFlightBudget,
        () => {
          logger.error('drain: awaitQuiescence timed out - proceeding with leftovers');
        },
      );

      // 4. Leftovers each markNeedsReconcile - never a blind retry. A
      // failure marking one leftover must not abort the rest or the drain.
      const leftovers = deps.inFlight.list();
      for (const entry of leftovers) {
        try {
          await deps.markNeedsReconcile(entry);
        } catch (err) {
          logger.error('drain: markNeedsReconcile failed for a leftover job', {
            jobId: entry.jobId,
            instanceId: entry.instanceId,
            err,
          });
        }
      }

      // 5-7. Per session: flushCreds (failure logged, never aborts) ->
      // endSocket -> releaseLease. Each leg budget-capped against the
      // remaining total so a hung port cannot push past totalMs.
      for (const session of deps.sessions) {
        await withBudget(
          async () => {
            try {
              await session.flushCreds();
            } catch (err) {
              logger.error(
                'drain: flushCreds failed - continuing (durable tier holds last good version)',
                {
                  instanceId: session.instanceId,
                  err,
                },
              );
            }
          },
          Math.max(0, remainingMs()),
          () => {
            logger.error('drain: flushCreds timed out - continuing', {
              instanceId: session.instanceId,
            });
          },
        );

        session.endSocket();

        await withBudget(
          async () => {
            try {
              await session.releaseLease();
            } catch (err) {
              logger.error('drain: releaseLease failed - continuing', {
                instanceId: session.instanceId,
                err,
              });
            }
          },
          Math.max(0, remainingMs()),
          () => {
            logger.error('drain: releaseLease timed out - continuing', {
              instanceId: session.instanceId,
            });
          },
        );
      }

      // 8. closePools - budget-capped too.
      await withBudget(
        async () => {
          try {
            await deps.closePools();
          } catch (err) {
            logger.error('drain: closePools failed - continuing to exit', { err });
          }
        },
        Math.max(0, remainingMs()),
        () => {
          logger.error('drain: closePools timed out - continuing to exit');
        },
      );

      // 9. exit(0) - never process.exit directly.
      deps.exit(0);
    },
  };
}
