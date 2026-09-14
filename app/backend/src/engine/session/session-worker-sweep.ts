import { logger } from '@wp/server-kit';
import type { TenantDb } from '@wp/db';
import {
  readLinkStatus,
  readSweepTeardownStatuses,
} from '../../modules/instances/instance-reads.repo.js';
import type { SessionRunnerRegistry } from './registry.js';

/**
 * session-worker-sweep.ts (FIX-P09-B split) - `sweepTeardowns`, mechanically
 * extracted out of `session-worker-composition.ts` for the max-lines cap.
 * Pure code motion: explicit parameters (`tenantDb`, `registry`) replace
 * closed-over module state. No logic change.
 */

/**
 * Per-client, per-tick cap on the sweep's fallback point-checks (C1 re-verify
 * note): a batch read coming back short for MANY held ids of one client is a
 * systemic short-read signal, never N independent hard-deletes - past this
 * cap the remaining missing handles are kept for the tick and retried next
 * scan instead of burning one round trip each.
 */
const SWEEP_POINT_CHECK_MISS_CAP = 25;

/**
 * ONE batched, CLIENT-scoped read per scan tick, per client, across every
 * instance this worker currently holds a registry handle for THAT client
 * (P08 FIX BATCH A, A9; FIX ROUND 2 FIX 1) - replaces a per-held-session
 * `readLinkStatus` loop (O(N) queries/tick, 2,000 queries/tick at the ADR
 * 0018 2,000-session target) with O(clients-with-held-sessions) queries/
 * tick. Client-scoped (via `tenantDb.withTenant`, the same mechanism
 * `instances/repo.ts`'s `InstanceCtx` reads use) because
 * `whatsapp_instances` has FORCE ROW LEVEL SECURITY keyed on
 * `app.client_id` and the worker role `wp_app` does not bypass it - a bare,
 * unscoped read under that role silently returns ZERO rows in production,
 * which used to be misread as "every held session is ineligible", mass-
 * tearing-down every healthy session each tick (see
 * `instance-sweep-teardown-status.sql`'s own header comment).
 *
 * FAILS CLOSED on a short read: if the client-scoped BATCH read returns
 * FEWER rows than ids requested for that client, each missing id gets ONE
 * fallback client-scoped point-check (`readLinkStatus`, the same proven
 * single-row read `instances.routes.ts`'s link-status endpoint already
 * uses under `wp_app`) rather than being assumed ineligible outright -
 * absence must never be indistinguishable from deletion caused by a
 * scoping/read bug. Only when BOTH the batch read AND the point-check
 * agree the row is gone is the id treated as genuinely hard-deleted
 * (teardown, matching the pre-existing hard-delete-mid-flight contract);
 * a point-check that DOES find the row is trusted and used. The point-
 * check itself is still client-scoped (never a global unscoped read), so
 * it carries the exact same RLS-correctness the batch read does - it adds
 * defense against a short BATCH specifically, not against RLS being wrong
 * for the whole client (which the client_id predicate above already
 * closes).
 */
export async function sweepTeardowns(
  tenantDb: TenantDb,
  registry: SessionRunnerRegistry,
): Promise<void> {
  const handles = [...registry.values()];
  if (handles.length === 0) {
    return;
  }

  const handlesByClientId = new Map<string, typeof handles>();
  for (const handle of handles) {
    const forClient = handlesByClientId.get(handle.clientId);
    if (forClient) {
      forClient.push(handle);
    } else {
      handlesByClientId.set(handle.clientId, [handle]);
    }
  }

  for (const [clientId, clientHandles] of handlesByClientId) {
    const instanceIds = clientHandles.map((handle) => handle.instanceId);
    const statuses = await tenantDb.withTenant(clientId, (tx) =>
      readSweepTeardownStatuses({ clientId, sql: tx }, instanceIds),
    );
    const statusByInstanceId = new Map(statuses.map((status) => [status.instanceId, status]));

    // C1 re-verify note: cap the per-miss fallback point-checks per client
    // per tick. Genuine misses are hard-delete-only and rare; a client-wide
    // short read is a SYSTEMIC signal (GUC/RLS/read fault), not N
    // independent deletions - past the cap, keep every remaining missing
    // handle for this tick and let the next tick retry.
    let pointCheckMisses = 0;
    let missCapLogged = false;

    for (const handle of clientHandles) {
      const status = statusByInstanceId.get(handle.instanceId);
      if (status === undefined) {
        pointCheckMisses += 1;
        if (pointCheckMisses > SWEEP_POINT_CHECK_MISS_CAP) {
          if (!missCapLogged) {
            missCapLogged = true;
            logger.warn(
              { client_id: clientId },
              'sweepTeardowns: per-client point-check miss cap exceeded - keeping all remaining missing handles this tick (systemic short-read signal, not N deletions)',
            );
          }
          continue;
        }
        // Fail-closed (FIX ROUND 2 FIX 1b): the batch read came back
        // short for this id - never assume ineligible outright. Fall back
        // to ONE client-scoped point-check (the same proven `wp_app`-safe
        // read `instances.routes.ts`'s link-status endpoint uses) before
        // deciding.
        logger.warn(
          { client_id: clientId, instance_id: handle.instanceId },
          'sweepTeardowns: batched client-scoped read returned no row for this held instance id - running a fallback point-check before deciding',
        );
        const pointStatus = await tenantDb.withTenant(clientId, (tx) =>
          readLinkStatus({ clientId, sql: tx }, handle.instanceId),
        );
        if (pointStatus === null) {
          // BOTH the batch read and the point-check agree the row is
          // gone - genuinely hard-deleted (or never existed for this
          // client). Only now is the id treated as eligible for teardown.
          await handle.teardownWithRelease();
          continue;
        }
        // The point-check DID find the row - trust it over the short
        // batch read.
        const pointEligible = pointStatus.desiredState === 'online';
        if (pointEligible) {
          continue;
        }
        await handle.teardownWithRelease();
        continue;
      }
      const stillEligible = status.deletedAt === null && status.desiredState === 'online';
      if (stillEligible) {
        continue;
      }
      await handle.teardownWithRelease();
    }
  }
}
