import { sql } from 'drizzle-orm';
import { check, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0044_health_signals_and_pause.sql` -
 * `instance_health_samples`, append-only sparkline history for the
 * per-instance health score/band the panel's health widget renders. Shape
 * follows `pacing-events.ts` exactly: uuid app-generated surrogate PK (a row
 * handle, not a uniqueness authority), `band` reusing `instance_pacing_
 * state.health_band`'s exact CHECK vocabulary. See the migration's own
 * header for the full "why" (retention, grants, index rationale).
 */
export const instanceHealthSamples = pgTable(
  'instance_health_samples',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    score: numeric('score').notNull(),
    band: text('band').notNull(),
    evidence: jsonb('evidence').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'instance_health_samples_band_check',
      sql`${table.band} IN ('healthy','watch','degraded','critical')`,
    ),
  ],
);
