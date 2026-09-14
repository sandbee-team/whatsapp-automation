-- P28 (admin-internal-api-and-panel) Unit U1 - migration 0071. Extends the
-- existing `notification_kind` enum (migration 0048) with fourteen staff-
-- action / admin-visible notification kinds - see
-- `packages/domain/src/enums/index.ts`'s `NOTIFICATION_KINDS` (appended,
-- same order) and `packages/domain/src/notifications/kinds.ts`'s
-- `NOTIFICATION_KIND_REGISTRY` for the severity/channel/dedupe-scope
-- entries `db/tests/enum-parity.test.ts` requires to already agree.
--
-- Nothing but the fourteen ADD VALUE statements, same precedent as
-- migrations 0059/0067/0069: `ALTER TYPE ... ADD VALUE` cannot be used in
-- the same transaction as a statement that reads the new value (PG12+),
-- but ADD VALUE statements alone, with no other DDL/DML in the same file,
-- run cleanly inside the single BEGIN/COMMIT `db/src/migrate.ts` wraps
-- every migration file in.
ALTER TYPE notification_kind ADD VALUE 'client_suspended';
ALTER TYPE notification_kind ADD VALUE 'client_reactivated';
ALTER TYPE notification_kind ADD VALUE 'wallet_frozen';
ALTER TYPE notification_kind ADD VALUE 'wallet_unfrozen';
ALTER TYPE notification_kind ADD VALUE 'wallet_credited_by_staff';
ALTER TYPE notification_kind ADD VALUE 'topup_rejected';
ALTER TYPE notification_kind ADD VALUE 'limits_changed';
ALTER TYPE notification_kind ADD VALUE 'pricing_changed';
ALTER TYPE notification_kind ADD VALUE 'pacing_relaxed';
ALTER TYPE notification_kind ADD VALUE 'instance_paused_by_staff';
ALTER TYPE notification_kind ADD VALUE 'instance_resumed_by_staff';
ALTER TYPE notification_kind ADD VALUE 'campaign_cancelled_by_staff';
ALTER TYPE notification_kind ADD VALUE 'impersonation_started';
ALTER TYPE notification_kind ADD VALUE 'impersonation_body_access';
