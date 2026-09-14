-- P19 Unit U4 (step 6) - migration 0059. Extends the existing
-- `notification_kind` enum (migration 0048) with the two wallet state
-- notifications: `wallet_low` (entering the `low` wallet state) and
-- `wallet_empty` (entering the `empty` wallet state) - see
-- `packages/domain/src/enums/index.ts`'s `NOTIFICATION_KINDS` (appended, same
-- order) and `packages/domain/src/notifications/kinds.ts`'s
-- `NOTIFICATION_KIND_REGISTRY` for the severity/channel/dedupe-scope
-- entries `db/tests/enum-parity.test.ts` requires to already agree.
--
-- Nothing but the two ADD VALUE statements: `ALTER TYPE ... ADD VALUE`
-- cannot be used in the same transaction as a statement that reads the new
-- value (PG12+), but two ADD VALUE statements alone, with no other DDL/DML
-- in the same file, run cleanly inside the single BEGIN/COMMIT
-- `db/src/migrate.ts` wraps every migration file in - there is no prior
-- enum-extension migration in this repo to follow as precedent; this file
-- is intentionally minimal for that reason (a companion CREATE/ALTER of any
-- other object in the same file would risk exactly the "used in the same
-- transaction" restriction above).
ALTER TYPE notification_kind ADD VALUE 'wallet_low';
ALTER TYPE notification_kind ADD VALUE 'wallet_empty';
