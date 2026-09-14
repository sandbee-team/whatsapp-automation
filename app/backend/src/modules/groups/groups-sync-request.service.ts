import type { TenantDb } from '@wp/db';
import { provisioningRepo } from '../tenancy/index.js';
import { requestGroupSync as requestGroupSyncRow, readGroupsSyncClock } from './groups.repo.js';
import { GroupInstanceNotFoundError, GroupSyncRateLimitedError } from './groups.errors.js';

/**
 * groups-sync-request.service.ts (P24 Unit U3c) - `requestGroupSync`,
 * split from `groups.service.ts` (which sits at the 300-line cap) purely
 * for file-size reasons; same module, same discipline. The API NEVER moves
 * `groups_next_sync_after`/`groups_last_synced_at` (worker-owned, migration
 * 0068's own header comment) - it only records the REQUEST timestamp via
 * ONE conditional UPDATE (`groups-request-sync.sql`), rate-gated by the
 * worker's own clock. The provider call itself happens later, off the
 * request path, when the worker's sync timer picks the request up
 * (`groups-sync-due.sql` / `sync.ts`).
 */

export interface GroupsSyncRequestServiceDeps {
  tenantDb: TenantDb;
}

export interface RequestGroupSyncResult {
  requestedAt: string;
  nextSyncAfter: string | null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** `retryAfterSeconds` is always at least 1 - a would-be-zero-or-negative gap (clock skew, a `nextSyncAfter` in the immediate past) is still a refusal, never a false "not rate-limited". */
function retryAfterSecondsFrom(nextSyncAfter: Date, now: number): number {
  return Math.max(1, Math.ceil((nextSyncAfter.getTime() - now) / 1000));
}

export async function requestGroupSync(
  deps: GroupsSyncRequestServiceDeps,
  input: { clientId: string; instanceId: string; userId: string },
): Promise<RequestGroupSyncResult> {
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const updated = await requestGroupSyncRow(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
    });
    if (updated) {
      await provisioningRepo.insertAuditLog(tx, {
        clientId: input.clientId,
        actorType: 'user',
        actorUserId: input.userId,
        action: 'group.sync_requested',
        targetType: 'instance',
        targetId: input.instanceId,
        metadata: {},
      });
      return {
        requestedAt: updated.groups_sync_requested_at.toISOString(),
        nextSyncAfter: toIso(updated.groups_next_sync_after),
      };
    }

    // Zero rows: either a genuinely foreign/missing/deleted instance (404),
    // or an in-window rate-limit refusal (429) - the read-fallback tells
    // these apart without ever writing a row on the refusal path.
    const clock = await readGroupsSyncClock(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
    });
    if (!clock) {
      throw new GroupInstanceNotFoundError();
    }
    const nextSyncAfter = clock.groups_next_sync_after;
    if (!nextSyncAfter) {
      // Should be unreachable (a null clock never fails the UPDATE's WHERE
      // clause) - fail-safe: still a rate-limit refusal, never a silent
      // success on a re-read race.
      throw new GroupSyncRateLimitedError(1);
    }
    throw new GroupSyncRateLimitedError(retryAfterSecondsFrom(nextSyncAfter, Date.now()));
  });
}
