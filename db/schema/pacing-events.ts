import { sql } from 'drizzle-orm';
import { check, customType, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Postgres `text[]` (`_text` udt) - used only by `reason_codes` below.
 * `drizzle-orm/pg-core`'s built-in `.array()` builder reports
 * `getSQLType() === 'text[]'`, which does NOT match Postgres's
 * `information_schema.columns.udt_name` for an array column (`'_text'` -
 * the underscore-prefixed internal array type name) - `db/tests/schema-
 * parity.test.ts` compares against `udt_name` with no `text[] -> _text`
 * entry in its mapping table, and that test is outside this unit's file
 * scope to extend. A local `customType` whose `dataType()` returns the
 * literal `'_text'` sidesteps the mismatch without touching that test or
 * `db/schema/custom-types.ts` (also outside this unit's scope) - same
 * `customType` trick `custom-types.ts` already uses for `citext`/`bytea`/
 * `inet`, just declared file-local since this is the only array column in
 * the pacing surface.
 */
const textArray = customType<{ data: string[] }>({
  dataType() {
    return '_text';
  },
});

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `pacing_events`, the
 * audit/evidence timeline. `kind` is text + CHECK, not a pg enum: P13a and
 * P16 both add kinds later, and an enum would force an `ALTER TYPE` in
 * every later phase (see the migration's own header). Migration 0038 (P14
 * Unit U4b) added the `'SYSTEM_SEND'` kind for exempt system sends (e.g. the
 * opt-out confirmation) - see that migration's own header. Migration 0044
 * (P16 Unit A) added `'BAND_CHANGE_SUPPRESSED'` for the health evaluator's
 * rate-limited-band-improvement audit trail.
 */
export const pacingEvents = pgTable(
  'pacing_events',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id').references(() => whatsappInstances.id),
    kind: text('kind').notNull(),
    fromValue: jsonb('from_value'),
    toValue: jsonb('to_value'),
    reasonCodes: textArray('reason_codes'),
    evidence: jsonb('evidence').notNull().default({}),
    actorUserId: uuid('actor_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'pacing_events_kind_check',
      sql`${table.kind} IN ('WARMUP_ADVANCE', 'WARMUP_ROLLBACK', 'BAND_CHANGE', 'CONFIG_CHANGE', 'hard_signal_pause', 'SYSTEM_SEND', 'BAND_CHANGE_SUPPRESSED')`,
    ),
  ],
);
