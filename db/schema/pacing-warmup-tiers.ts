import {
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { pacingProfiles } from './pacing-profiles.js';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `pacing_warmup_tiers`,
 * the per-profile, per-tier warm-up ladder (seeded by migration 0031). No
 * `client_id` - a global catalog keyed on `profile_key`, same class as
 * `pacing_profiles` (see that file's own header). `group_daily_cap` is the
 * scope-delta group column, folded into the CREATE TABLE at migration time.
 *
 * `numeric('cold_ratio_max')` carries no `{ precision, scale }` - see
 * `pacing-profiles.ts`'s header for why (`udt_name` parity with the live
 * `numeric(4,3)` column).
 */
export const pacingWarmupTiers = pgTable(
  'pacing_warmup_tiers',
  {
    profileKey: text('profile_key')
      .notNull()
      .references(() => pacingProfiles.key),
    tier: smallint('tier').notNull(),
    dayFrom: integer('day_from'),
    dayTo: integer('day_to'),
    dailyCap: integer('daily_cap'),
    hourlyCap: integer('hourly_cap'),
    newConvCap: integer('new_conv_cap'),
    gapMinMs: integer('gap_min_ms'),
    gapMaxMs: integer('gap_max_ms'),
    coldRatioMax: numeric('cold_ratio_max'),
    blockLinkFirstMessage: boolean('block_link_first_message'),
    blockGroupActions: boolean('block_group_actions'),
    groupDailyCap: integer('group_daily_cap').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.profileKey, table.tier] })],
);
