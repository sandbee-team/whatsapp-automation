import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres `citext` (case-insensitive text), used for `users.email` and
 * `clients.slug`. Drizzle's `pg-core` has no built-in `citext` column type,
 * hence this thin `customType` wrapper - `dataType()` returns the exact SQL
 * type name, which is also what `column.getSQLType()` reports back to
 * `db/tests/schema-parity.test.ts`. The extension itself is created by
 * `db/migrations/0001_extensions_and_enums.sql`.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Postgres `bytea` (variable-length binary) - used by P03's
 * `message_jobs.recipient_hash`/`content_fingerprint` and similar hash/
 * fingerprint columns. Same `customType` trick as `citext` above: pg-core has
 * no built-in `bytea` builder, and `dataType()`'s return value is what
 * `db/tests/schema-parity.test.ts` compares against `udt_name`.
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Postgres `inet` (IP address, with optional netmask) - used by P04a's
 * `auth_sessions.ip`/`audit_logs.ip`. Same `customType` trick as `citext`/
 * `bytea` above: pg-core has no built-in `inet` builder.
 */
export const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

/**
 * Postgres `char(2)` (fixed-width ISO country code) - used by P20's
 * `clients.country_code`/`contact_imports.default_country`. Drizzle's
 * built-in `char()` builder reports `getSQLType()` as `char(2)`, which does
 * not match `information_schema.columns.udt_name` (`bpchar`) - same trick
 * `wallet.ts`'s local `currencyCode` custom type uses for `char(3)`, hoisted
 * here so both callers share one implementation.
 */
export const bpchar2 = customType<{ data: string }>({
  dataType() {
    return 'bpchar';
  },
});
