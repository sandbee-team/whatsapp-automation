-- Fixture (P14 C5): ALTER COLUMN ... SET DEFAULT and ALTER COLUMN ... SET
-- DATA TYPE are column-attribute DDL clauses, never session-scoped leaks -
-- must stay clean.
ALTER TABLE pacing_profiles
  ALTER COLUMN dup_fanout_warn SET DEFAULT 150,
  ALTER COLUMN dup_fanout_ack SET DATA TYPE integer,
  ALTER COLUMN per_recipient_24h SET STATISTICS 100;
