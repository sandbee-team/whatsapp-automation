import type { TenantDb, TenantQueryable } from '@wp/db';
import { canSendToGroup, MAX_TRACKED_PARTICIPANT_DEVICES } from '@wp/domain';
import type { GroupSummary } from '@wp/contracts';
import { provisioningRepo } from '../tenancy/index.js';
import { encodeGroupCursor, decodeGroupCursor } from './groups-cursor.js';
import {
  listGroups,
  enabledDevicesTotal,
  readGroupCapToday,
  requestLeave,
  readLeaveRequestedAt,
} from './groups.repo.js';
import { GroupInstanceNotFoundError, GroupNotFoundError } from './groups.errors.js';
import { toGroupSummary, toEligibility, toIso } from './groups-summary.js';

/**
 * groups.service.ts (P24 Unit U3, step 4/5; C2 fix round moved
 * `setGroupSendEnabled` out to `groups-send-enabled.service.ts`, see Fix 1)
 * - the tenant group business logic: list (with per-row eligibility +
 * device budget + group-cap block) and leave (always allowed, idempotent,
 * audited once). The API NEVER calls the provider (api.md rule 3) - leave
 * is EXECUTED by the worker's own sync/leave loop (`sync.ts`), this service
 * only records the request.
 */

export interface GroupsServiceDeps {
  tenantDb: TenantDb;
}

const LIST_PAGE_SIZE = 50;

interface InstanceSyncClockRow extends Record<string, unknown> {
  groups_last_synced_at: Date | null;
  groups_next_sync_after: Date | null;
  groups_sync_requested_at: Date | null;
}

/** Tiny, tenant-scoped existence + sync-clock read - deliberately inline (no `groups-*.sql` file) since it is a single-table, single-predicate SELECT with no other consumer, and `modules/instances/repo.ts` is outside this unit's file scope. */
async function readInstanceSyncClock(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<InstanceSyncClockRow | undefined> {
  const result = await tx.query<InstanceSyncClockRow>(
    `SELECT groups_last_synced_at, groups_next_sync_after, groups_sync_requested_at
       FROM whatsapp_instances
      WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [instanceId, clientId],
  );
  return result.rows[0];
}

export interface ListGroupsResult {
  items: GroupSummary[];
  nextCursor?: string;
  budget: { trackedDevicesEnabledTotal: number; max: number };
  groupCap: {
    warmupTier: number;
    healthBand: string;
    effGroupDailyCap: number;
    sentToday: number;
    remainingToday: number;
  };
  sync: { lastSyncedAt: string | null; nextSyncAfter: string | null; requestedAt: string | null };
}

export async function listGroupsForInstance(
  deps: GroupsServiceDeps,
  input: { clientId: string; instanceId: string; cursor?: string; limit?: number },
): Promise<ListGroupsResult> {
  const afterId = input.cursor ? decodeGroupCursor(input.cursor) : null;
  const limit = input.limit ?? LIST_PAGE_SIZE;

  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const instance = await readInstanceSyncClock(tx, input.clientId, input.instanceId);
    if (!instance) {
      throw new GroupInstanceNotFoundError();
    }

    const rows = await listGroups(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      afterId,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const trackedDevicesEnabledTotal = await enabledDevicesTotal(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
    });
    const capRow = await readGroupCapToday(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
    });
    const effGroupDailyCap = capRow?.eff_group_daily_cap ?? 0;
    const sentToday = capRow?.sent_today ?? 0;

    const items = page.map((row) =>
      toGroupSummary(
        row,
        toEligibility(
          canSendToGroup({
            sendEnabled: row.send_enabled,
            isAnnounce: row.is_announce,
            ourRole: row.our_role,
            effGroupDailyCap,
            trackedDevicesInstanceTotal: trackedDevicesEnabledTotal,
            groupTrackedDevices: row.tracked_participant_devices,
          }),
        ),
      ),
    );

    const lastRow = page[page.length - 1];
    return {
      items,
      ...(hasMore && lastRow ? { nextCursor: encodeGroupCursor(lastRow.id) } : {}),
      budget: { trackedDevicesEnabledTotal, max: MAX_TRACKED_PARTICIPANT_DEVICES },
      groupCap: {
        warmupTier: capRow?.warmup_tier ?? 1,
        healthBand: capRow?.health_band ?? 'healthy',
        effGroupDailyCap,
        sentToday,
        remainingToday: Math.max(0, effGroupDailyCap - sentToday),
      },
      sync: {
        lastSyncedAt: toIso(instance.groups_last_synced_at),
        nextSyncAfter: toIso(instance.groups_next_sync_after),
        requestedAt: toIso(instance.groups_sync_requested_at),
      },
    };
  });
}

export async function requestGroupLeave(
  deps: GroupsServiceDeps,
  input: { clientId: string; id: string; userId: string },
): Promise<{ leaveRequestedAt: string }> {
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const requested = await requestLeave(tx, { clientId: input.clientId, id: input.id });
    if (requested) {
      await provisioningRepo.insertAuditLog(tx, {
        clientId: input.clientId,
        actorType: 'user',
        actorUserId: input.userId,
        action: 'group.leave_requested',
        targetType: 'wa_group',
        targetId: input.id,
        metadata: {},
      });
      return { leaveRequestedAt: requested.toISOString() };
    }

    // Zero rows: either already-pending (idempotent replay, no second audit
    // row) or a genuinely foreign/missing/already-left id (404).
    const existing = await readLeaveRequestedAt(tx, { clientId: input.clientId, id: input.id });
    if (existing === undefined || existing === null) {
      throw new GroupNotFoundError();
    }
    return { leaveRequestedAt: existing.toISOString() };
  });
}
