import { loadQuery, bindQueryParams } from '@wp/db';
import type { TenantDb, TenantQueryable } from '@wp/db';
import type { GroupSocketPort } from './sync.js';

/**
 * sync-worker.ts (P24 Unit U3, step 5) - worker-side execution of pending
 * group leaves: for every `wa_groups` row of the given instance with
 * `leave_requested_at IS NOT NULL AND left_at IS NULL`, calls
 * `groupSocket.groupLeave(jid)` then marks the row left. A provider error on
 * one leave is logged (ids only) and retried on the next tick - never
 * escalated to any health signal (leaving is a de-escalation, not a fault).
 * Split from `sync.ts` (own concern: leave, not sync) - both are called from
 * `session-groups-sync-timer.ts`'s own per-instance tick.
 */

const LEAVE_BATCH_LIMIT = 20;

interface PendingLeaveRow extends Record<string, unknown> {
  id: string;
  group_jid: string;
}

async function listPendingLeaves(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<PendingLeaveRow[]> {
  const query = await loadQuery('groups-leave-pending');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    limit: LEAVE_BATCH_LIMIT,
  });
  const result = await tx.query<PendingLeaveRow>(query.text, params);
  return result.rows;
}

async function markLeft(
  tx: TenantQueryable,
  input: { clientId: string; id: string },
): Promise<void> {
  const query = await loadQuery('groups-mark-left');
  const params = bindQueryParams(query, { client_id: input.clientId, id: input.id });
  await tx.query(query.text, params);
}

export interface RunPendingGroupLeavesDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  groupSocket: GroupSocketPort;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** Executes every pending leave for one instance, sequentially. One provider error never aborts the rest of the batch. */
export async function runPendingGroupLeaves(deps: RunPendingGroupLeavesDeps): Promise<void> {
  const pending = await deps.tenantDb.withTenant(deps.clientId, (tx) =>
    listPendingLeaves(tx, { clientId: deps.clientId, instanceId: deps.instanceId }),
  );

  for (const row of pending) {
    try {
      await deps.groupSocket.groupLeave(row.group_jid);
      await deps.tenantDb.withTenant(deps.clientId, (tx) =>
        markLeft(tx, { clientId: deps.clientId, id: row.id }),
      );
    } catch (err) {
      deps.logger.warn(
        {
          client_id: deps.clientId,
          instance_id: deps.instanceId,
          group_id: row.id,
          error_class: err instanceof Error ? err.name : 'unknown',
        },
        'groups: pending leave failed, will retry next tick',
      );
    }
  }
}
