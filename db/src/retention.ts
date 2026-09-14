/**
 * P23 (broadcast-campaigns) Unit U1 - the single registry of data-retention
 * policies. This file registers policy DATA only - it schedules nothing and
 * deletes nothing; P25 wires the scheduler that actually runs a policy's
 * `action` on its `scheduledBy` cadence. Nothing here reads `process.env` or
 * touches a database connection, matching `tenant-tables.ts`'s "data only"
 * convention so this module is safe to import from `db/src`, `app/backend`
 * and `scripts/` alike.
 *
 * `campaign_recipients` is archived WITH its owning `campaigns` row (not
 * independently) at 13 months, then deleted in rate-limited batches - see
 * the scope-delta's "Bound and retention, decided" paragraph. No DELETE
 * grant exists on `campaign_recipients` for any role today (migration 0064)
 * precisely because this phase registers the policy only; the rate-limited
 * batch deleter that P25 builds is the only writer this action is meant for.
 */
export interface RetentionPolicy {
  /** The table this policy governs. */
  readonly table: string;
  /** The table this row is archived alongside (same archive unit). */
  readonly archiveWith: string;
  /** How long a row is retained before it becomes eligible for archival. */
  readonly retainMonths: number;
  /** What happens to an eligible row. */
  readonly action: 'archive_then_delete';
  /** How the delete half of the action is carried out. */
  readonly deleteMode: 'rate_limited_batches';
  /** Which phase wires the scheduler that actually runs this policy. */
  readonly scheduledBy: string;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = Object.freeze([
  Object.freeze({
    table: 'campaign_recipients',
    archiveWith: 'campaigns',
    retainMonths: 13,
    action: 'archive_then_delete',
    deleteMode: 'rate_limited_batches',
    scheduledBy: 'P25',
  }),
]);
