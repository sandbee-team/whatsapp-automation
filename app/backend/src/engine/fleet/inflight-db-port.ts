import type { TenantDb } from '@wp/db';
import type { InFlightEntry, InFlightPort } from './drain.js';

/**
 * inflight-db-port.ts (P26 rolling-deploy chaos fix, debugger session
 * 2026-09-11; moved to a production-neutral home 2026-09-11 launch-checklist
 * row 31; C1 fix round 2026-09-11 - see findings 1-6 below) - the REAL
 * `InFlightPort` for `createDrain`'s wiring, replacing
 * `fleet-adapters.ts#buildEmptyInFlightPort` (documented there as "P11
 * provides the real in-flight-send tracker" - never actually built, so every
 * graceful drain silently abandoned any job whose claim raced the drain, with
 * NO `needs_reconcile` marking - only the reaper's lease-expiry sweep
 * (claimExpiryMs 90s + graceSeconds 30s later) ever repaired it.
 *
 * Lives under `engine/fleet/**` (NOT `engine/measure/**`) specifically so
 * BOTH the production `roles/session-worker.ts` drain wiring and the
 * fleet-scale harness child (`engine/measure/scale-fleet-child.ts`) can import
 * it - `src-never-imports-engine-measure` (`.dependency-cruiser.cjs`) forbids
 * any `app/backend/src/**` outside `engine/measure/**` from reaching into the
 * benchmark tree, so this port could never have stayed there once production
 * code needed it too.
 *
 * DELIBERATELY DB-DERIVED, NOT IN-MEMORY: `send-loop-fleet-wiring.ts`'s
 * `RunningEntry.inFlight` is a bare boolean with no job id, and threading a
 * job id through `runOneSendLoopIteration`/`trigger()` end-to-end would widen
 * that module's own contract for this concern. `message_jobs` is already the
 * arbiter of "is this job still processing" (core invariant 3), so this
 * adapter queries it directly, scoped to the instances THIS worker currently
 * holds (invariant 4).
 *
 * C1 FINDING 1 (CRITICAL): `message_jobs` is `ENABLE + FORCE ROW LEVEL
 * SECURITY` (migration 0007) with policy `USING (client_id =
 * nullif(current_setting('app.client_id', true), '')::uuid)`. A bare
 * `pool.query()` never sets that GUC, so under the production role
 * `wp_scheduler` (which does NOT bypass RLS, unlike the dev/test superuser
 * `wp`) the predicate is `client_id = NULL` - ZERO rows, silently reproducing
 * the exact `buildEmptyInFlightPort` behaviour this port exists to replace.
 * FIX: this module now takes a `TenantDb` and runs the leftover query PER
 * CLIENT inside `tenantDb.withTenant(clientId, ...)`, scoped to just that
 * client's owned instance ids (dropping the now-redundant `client_id =
 * ANY($n)` predicate - the GUC already scopes it). See precedent
 * `engine/queue/send-loop-worker-wiring.ts` (same class, same fix) and
 * `send-loop-worker-wiring.rls.integration.test.ts` (the role-scoped proof
 * idiom this file's own integration test copies).
 *
 * `awaitQuiescence` polls (never sleeps blindly) until zero `processing` rows
 * remain for these instances or the deadline passes, caching the final
 * leftover snapshot for the immediately-following synchronous `list()` call
 * (`drain.ts#run` always calls `list()` right after `awaitQuiescence`
 * resolves - see that module's own step ordering).
 */

interface LeftoverRow extends Record<string, unknown> {
  id: string;
  instance_id: string;
  client_id: string;
}

/** One client's owned instance ids - the unit `queryLeftoversForClient` scopes one `withTenant` call to. */
interface ClientScope {
  clientId: string;
  instanceIds: string[];
}

/**
 * Groups `(instanceId, clientId)` pairs by client, so the caller can issue
 * exactly one `withTenant` query per client instead of per instance.
 */
function groupByClient(
  ownedPairs: readonly { instanceId: string; clientId: string }[],
): ClientScope[] {
  const byClient = new Map<string, string[]>();
  for (const pair of ownedPairs) {
    const existing = byClient.get(pair.clientId);
    if (existing) {
      existing.push(pair.instanceId);
    } else {
      byClient.set(pair.clientId, [pair.instanceId]);
    }
  }
  return [...byClient.entries()].map(([clientId, instanceIds]) => ({ clientId, instanceIds }));
}

/**
 * C1 FINDING 2 (MAJOR): no `LIMIT` - the only `status='processing'` index
 * (`message_jobs_lease_expiry_idx`, migration 0007) is NOT led by
 * `instance_id`, so an unbounded scan under a busy tenant is unbounded scan
 * cost per poll. Capped at 500 (mirrors the `LEAST(GREATEST(max_rows, 0),
 * 500)` clamp in migration 0019) - a draining worker owns at most a handful
 * of instances, so 500 leftover `processing` rows for ONE client is already
 * far past anything this port needs to see in one poll; an index led by
 * `client_id, instance_id` would remove the scan-cost concern entirely, but
 * is deliberately deferred (a migration is out of scope for this fix round -
 * follow-up, not a blocker here).
 */
const LEFTOVER_QUERY_LIMIT = 500;

async function queryLeftoversForClient(
  tenantDb: TenantDb,
  scope: ClientScope,
): Promise<InFlightEntry[]> {
  if (scope.instanceIds.length === 0) return [];
  return tenantDb.withTenant(scope.clientId, async (tx) => {
    // client_id = $2 is belt-and-suspenders alongside the app.client_id GUC
    // withTenant already sets (never load-bearing on its own) - kept explicit
    // to match every other tenant-scoped statement in this codebase
    // (db/queries/claim-jobs.sql's own WHERE j.client_id = $client_id is the
    // same shape even though it too runs under withTenant) and to satisfy
    // check-tenant-scope.ts's static per-statement scan, which has no
    // knowledge of the surrounding withTenant wrapper.
    const result = await tx.query<LeftoverRow>(
      `SELECT id, instance_id, client_id FROM message_jobs
        WHERE status = 'processing' AND instance_id = ANY($1) AND client_id = $2
        ORDER BY id
        LIMIT ${String(LEFTOVER_QUERY_LIMIT)}`,
      [scope.instanceIds, scope.clientId],
    );
    return result.rows.map((row) => ({
      jobId: row.id,
      instanceId: row.instance_id,
      clientId: row.client_id,
    }));
  });
}

async function queryLeftovers(
  tenantDb: TenantDb,
  scopes: readonly ClientScope[],
): Promise<InFlightEntry[]> {
  const perClient = await Promise.all(
    scopes.map((scope) => queryLeftoversForClient(tenantDb, scope)),
  );
  return perClient.flat();
}

/**
 * Builds a real, DB-backed `InFlightPort` for exactly the `(instanceId,
 * clientId)` pairs this worker currently owns. `pollMs` is bounded and
 * injectable for tests; production/harness callers use the default (C1
 * FINDING 2: 200 -> 500ms, matching the accepted per-poll scan cost above).
 */
export function buildDbInFlightPort(
  tenantDb: TenantDb,
  ownedPairs: readonly { instanceId: string; clientId: string }[],
  pollMs = 500,
): InFlightPort {
  const scopes = groupByClient(ownedPairs);
  // C1 FINDING 4 (MAJOR): a private, non-exported binding - `list()` returns
  // a FRESH COPY of this below, never this array itself, so an abandoned
  // poll (see drain.ts's `withBudget`) mutating `lastSeen` after `list()` was
  // already read cannot retroactively change what the caller saw.
  let lastSeen: InFlightEntry[] = [];

  return {
    list(): InFlightEntry[] {
      return [...lastSeen];
    },
    async awaitQuiescence(deadlineMs: number): Promise<void> {
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        // C1 FINDING 3a (MAJOR): check the deadline BEFORE issuing each query
        // too, not just after awaiting it - a query issued at deadline-1ms
        // would otherwise overrun the deadline by that query's own latency.
        if (Date.now() >= deadline) return;
        const found = await queryLeftovers(tenantDb, scopes);
        lastSeen = found;
        if (lastSeen.length === 0) return;
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
