import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';
import { pacingProfiles } from './pacing-profiles.js';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `instance_pacing_
 * state`, ONE row per instance: warm-up progress, health score/band, and
 * the MATERIALISED resolved (`eff_*`) limits the reserve statement reads
 * in-statement. Deliberately carries NO reserve counter column of its own -
 * `db/tests/pacing-schema.test.ts`'s `instance_pacing_state_holds_no_
 * counter_column` case is the regression guard for that. `eff_group_daily_
 * cap` is the scope-delta group column.
 *
 * `numeric(...)` columns below carry no `{ precision, scale }` - see
 * `pacing-profiles.ts`'s header for why (`udt_name` parity).
 */
export const instancePacingState = pgTable(
  'instance_pacing_state',
  {
    instanceId: uuid('instance_id')
      .primaryKey()
      .references(() => whatsappInstances.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    profileKey: text('profile_key')
      .notNull()
      .default('safe_default')
      .references(() => pacingProfiles.key),
    pacingTimezone: text('pacing_timezone').notNull().default('Asia/Kolkata'),
    pacingTimezoneChangedAt: timestamp('pacing_timezone_changed_at', { withTimezone: true }),
    warmupTier: smallint('warmup_tier').notNull().default(1),
    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    warmupTierSince: timestamp('warmup_tier_since', { withTimezone: true }),
    healthScore: numeric('health_score').notNull().default('85.00'),
    healthBand: text('health_band').notNull().default('healthy'),
    healthBandSince: timestamp('health_band_since', { withTimezone: true }),
    lastBandImprovedAt: timestamp('last_band_improved_at', { withTimezone: true }),
    lastEvidence: jsonb('last_evidence').notNull().default({}),
    engagementExempt: boolean('engagement_exempt').notNull().default(false),
    engagementExemptReason: text('engagement_exempt_reason'),
    effDailyCap: integer('eff_daily_cap').notNull(),
    effHourlyCap: integer('eff_hourly_cap').notNull(),
    effNewConvCap: integer('eff_new_conv_cap').notNull(),
    effGapMinMs: integer('eff_gap_min_ms').notNull(),
    effGapMaxMs: integer('eff_gap_max_ms').notNull(),
    effColdRatioMax: numeric('eff_cold_ratio_max').notNull(),
    effColdRatioFloor: integer('eff_cold_ratio_floor').notNull(),
    effWindowStartLocal: time('eff_window_start_local').notNull(),
    effWindowEndLocal: time('eff_window_end_local').notNull(),
    effGroupDailyCap: integer('eff_group_daily_cap').notNull().default(0),
    configVersion: integer('config_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // P16 (health-signals-and-pause) Unit A, migration 0044 - the health
    // evaluator's own due-scan scheduling state. See that migration's header.
    evalDueAt: timestamp('eval_due_at', { withTimezone: true }).notNull().defaultNow(),
    evalTier: smallint('eval_tier').notNull().default(2),
    lastHardSignalAt: timestamp('last_hard_signal_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'ips_health_band_check',
      sql`${table.healthBand} IN ('healthy','watch','degraded','critical')`,
    ),
    check(
      'ips_engagement_exempt_reason_check',
      sql`NOT ${table.engagementExempt} OR ${table.engagementExemptReason} IS NOT NULL`,
    ),
    check('instance_pacing_state_eval_tier_check', sql`${table.evalTier} IN (1, 2, 3)`),
  ],
);
