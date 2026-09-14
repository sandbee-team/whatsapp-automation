import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './custom-types.js';

/**
 * Drizzle mirror of `db/migrations/0074_leads.sql` - `leads`. Non-tenant (no
 * client_id) - the marketing site posts to a public endpoint on
 * admin/backend that writes this row before any client exists (blueprint
 * [R-52]), same non-tenant class as `staffUsers`/`staffSessions`
 * (`./staff-users.ts`). `ipHash` is an HMAC-SHA256 hex digest, never a raw
 * IP - the CHECK below enforces the 64-lowercase-hex shape at the storage
 * layer. Every free-text field carries the same storage-layer size CHECK as
 * the migration.
 */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: citext('email').notNull(),
    company: text('company'),
    phoneE164: text('phone_e164'),
    message: text('message'),
    source: text('source').notNull(),
    utm: jsonb('utm').notNull().default({}),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('leads_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check('leads_email_check', sql`char_length(${table.email}) BETWEEN 3 AND 254`),
    check('leads_company_check', sql`char_length(${table.company}) <= 120`),
    check('leads_phone_e164_check', sql`${table.phoneE164} ~ '^\+[1-9][0-9]{7,14}$'`),
    check('leads_message_check', sql`char_length(${table.message}) <= 2000`),
    check('leads_source_check', sql`${table.source} ~ '^[a-z0-9-]{1,64}$'`),
    check(
      'leads_utm_check',
      sql`jsonb_typeof(${table.utm}) = 'object' AND pg_column_size(${table.utm}) <= 2048`,
    ),
    check('leads_ip_hash_check', sql`${table.ipHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
