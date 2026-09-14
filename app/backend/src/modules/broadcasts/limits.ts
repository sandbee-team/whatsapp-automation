import type { TenantQueryable } from '@wp/db';

/**
 * limits.ts (P23 Unit U4, step 4) - the `max_broadcast_recipients` admission
 * ceiling resolver, same shape as `modules/contacts/contacts-limits.ts#
 * resolveEffectiveMaxContacts` (COALESCE override -> plan; `null` = no plan =
 * FAIL CLOSED, never "unlimited"). No advisory lock here (unlike contacts'
 * `assertUnderContactLimit`): the ceiling is checked exactly once, before the
 * FIRST snapshot batch of a given campaign (`snapshot_cursor_contact_id IS
 * NULL`), and a campaign has exactly one snapshot worker running against it
 * at a time by construction (a single cron sweep processes one batch per
 * campaign per tick, and the ceiling check only ever runs on the very first
 * batch) - there is no concurrent-admission race to serialise against.
 */
export class BroadcastLimitError extends Error {
  readonly reason: 'no_plan' | 'audience_over_plan_limit';
  readonly count?: number;
  readonly limit?: number;

  constructor(reason: 'no_plan' | 'audience_over_plan_limit', count?: number, limit?: number) {
    super(
      reason === 'no_plan'
        ? 'This client has no plan assigned; broadcasts cannot be sized.'
        : `Audience (${String(count)}) exceeds the plan's broadcast recipient limit (${String(limit)}).`,
    );
    this.name = 'BroadcastLimitError';
    this.reason = reason;
    this.count = count;
    this.limit = limit;
  }
}

/** `COALESCE(override, plan_limits.max_broadcast_recipients)` - `null` when the client has no plan. Mirrors `contacts-limits.ts#resolveEffectiveMaxContacts` verbatim, keyed on `'max_broadcast_recipients'`. */
export async function resolveEffectiveMaxBroadcastRecipients(
  tx: TenantQueryable,
  clientId: string,
): Promise<number | null> {
  const result = await tx.query<{ effective: number | null }>(
    `SELECT COALESCE(
              (SELECT limit_value FROM client_limit_overrides
                WHERE client_id = $1 AND limit_key = 'max_broadcast_recipients'
                  AND (expires_at IS NULL OR expires_at > now())),
              (SELECT pl.max_broadcast_recipients FROM clients c
                 JOIN plan_limits pl ON pl.plan_id = c.plan_id
                WHERE c.id = $1)
              -- client_id = id = $1
            ) AS effective`,
    [clientId],
  );
  return result.rows[0]?.effective ?? null;
}

/** Cancel-reason string stamped onto `campaigns.cancel_reason` when the audience exceeds the effective ceiling - `'audience_over_plan_limit:<count>/<limit>'`, never a silent truncation. */
export function audienceOverLimitReason(count: number, limit: number): string {
  return `audience_over_plan_limit:${String(count)}/${String(limit)}`;
}
