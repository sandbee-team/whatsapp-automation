-- Fixture (P14 C5): ALTER TABLE ... ALTER COLUMN ... SET NOT NULL is a
-- column-attribute DDL clause, never a session-scoped leak - must stay
-- clean. Exact shape from db/migrations/0040 (multi-clause ALTER TABLE with
-- several ALTER COLUMN ... SET NOT NULL clauses followed by ADD CONSTRAINT).
ALTER TABLE pacing_profiles
  ALTER COLUMN per_recipient_24h SET NOT NULL,
  ALTER COLUMN per_recipient_7d SET NOT NULL,
  ALTER COLUMN dup_fanout_warn SET NOT NULL,
  ALTER COLUMN dup_fanout_ack SET NOT NULL,
  ADD CONSTRAINT pacing_profiles_per_recipient_24h_positive CHECK (per_recipient_24h > 0),
  ADD CONSTRAINT pacing_profiles_per_recipient_7d_positive CHECK (per_recipient_7d > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_warn_positive CHECK (dup_fanout_warn > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_ack_positive CHECK (dup_fanout_ack > 0),
  ADD CONSTRAINT pacing_profiles_dup_fanout_warn_lt_ack CHECK (dup_fanout_warn < dup_fanout_ack);
