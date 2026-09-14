import type { InstanceOwnershipPort } from '../realtime/index.js';

/**
 * ownership.ts (P08 Unit U4) - the real `InstanceOwnershipPort`
 * implementation (`modules/realtime/service.ts`), replacing
 * `failClosedInstanceOwnership` in `roles/api.ts`'s realtime composition now
 * that `whatsapp_instances` is a real, owned table. Same shape as
 * `tenancy-scoped.repo.ts`'s `findClientIdForUser` - a single, minimal SELECT
 * with no ORM layer. `deleted_at IS NULL` excludes a soft-deleted instance
 * from ownership: a caller must never be granted a realtime channel for an
 * instance it has (soft-)deleted.
 */
export interface InstanceOwnershipDb {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export function createInstanceOwnership(pool: InstanceOwnershipDb): InstanceOwnershipPort {
  return {
    async isOwnedBy(clientId: string, instanceId: string): Promise<boolean> {
      const result = await pool.query(
        `SELECT 1 FROM whatsapp_instances WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
        [instanceId, clientId],
      );
      return result.rows.length > 0;
    },
  };
}
