-- P03 (db-queue-and-claim) - migration 0011.
-- Adds `message_jobs.updated_at`, forward-only fix for a transcription gap:
-- the architecture blueprint's prose column list for `message_jobs`
-- (migration 0007) carried `created_at` (called out explicitly as the
-- partition key / PK component) but dropped its sibling `updated_at`, even
-- though every other P02+ business table carries `updated_at timestamptz
-- NOT NULL DEFAULT now()` by convention, and the canon claim statement
-- (db/queries/claim-jobs.sql) and the canonical P18 wallet-debit statement
-- both `SET updated_at = now()` against this table. The column is canon;
-- migration 0007 was short. No other column, index, grant, or RLS policy on
-- `message_jobs` changes here.

ALTER TABLE message_jobs
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
