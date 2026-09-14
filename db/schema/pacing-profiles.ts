import { integer, numeric, pgTable, text, time, boolean } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `pacing_profiles`, the
 * global, staff-owned catalog of named pacing profiles
 * (`conservative`/`safe_default`/`steady`, seeded by migration 0031). No
 * `client_id` - a platform catalog, same class as `plans`/`plan_limits`
 * (`db/schema/tenancy.ts`), registered in `ISOLATION_NON_TENANT_TABLES`
 * (`db/src/isolation/tenant-tables.ts`), not `TENANT_TABLE_COVERAGE`.
 *
 * `numeric('cold_ratio_max')` is declared WITHOUT a `{ precision, scale }`
 * option deliberately: Drizzle's `getSQLType()` for a bare `numeric()` call
 * returns the bare string `'numeric'`, which is exactly what Postgres's
 * `information_schema.columns.udt_name` reports for a `numeric(4,3)` column
 * (the precision/scale are metadata `information_schema` exposes via
 * separate `numeric_precision`/`numeric_scale` columns, not folded into
 * `udt_name`) - `db/tests/schema-parity.test.ts` compares `udt_name` only,
 * so adding `{ precision: 4, scale: 3 }` here would make `getSQLType()`
 * return `'numeric(4, 3)'` and fail parity against the live `'numeric'`
 * udt_name. Same reasoning applies to every other `numeric(...)` column in
 * this phase's mirrors.
 */
export const pacingProfiles = pgTable('pacing_profiles', {
  key: text('key').primaryKey(),
  name: text('name'),
  isSystem: boolean('is_system').notNull().default(true),
  dailyCapCeiling: integer('daily_cap_ceiling'),
  gapMinFloorMs: integer('gap_min_floor_ms'),
  windowStartLocal: time('window_start_local'),
  windowEndLocal: time('window_end_local'),
  coldRatioMax: numeric('cold_ratio_max'),
  coldRatioFloor: integer('cold_ratio_floor'),
  // migration 0040 (P14 review-fix F1/F2, Finding 5): NOT NULL + CHECK(> 0) -
  // a TypeScript-only floor is not a floor (core invariant 6); the database
  // row itself must enforce it for every writer.
  perRecipient24h: integer('per_recipient_24h').notNull(),
  perRecipient7d: integer('per_recipient_7d').notNull(),
  dupFanoutWarn: integer('dup_fanout_warn').notNull(),
  dupFanoutAck: integer('dup_fanout_ack').notNull(),
  hourlyCapCeiling: integer('hourly_cap_ceiling'),
});
