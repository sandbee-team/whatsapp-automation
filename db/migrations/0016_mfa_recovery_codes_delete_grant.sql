-- P04b (wp_app RLS proof work) - wp_app grant fix on mfa_recovery_codes.
-- Forward-only, additive: adds the one missing privilege to the 0014 grant
-- set - no table/column drop, no data loss.
--
-- 0014 granted wp_app only SELECT, INSERT, UPDATE on mfa_recovery_codes.
-- `totp.service.ts`'s `enrolConfirm` (FIX 11b, P04a FIXB) runs
-- `deleteUnusedMfaRecoveryCodes` (mfa.repo.ts) - a
-- `DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL` -
-- as the first statement of the single delete-then-insert transaction that
-- confirms TOTP enrolment, so wp_app must hold DELETE on this table or that
-- transaction fails outright under wp_app + FORCE RLS in production. Found
-- by the P04b wp_app proof work (see
-- app/backend/src/modules/identity/__tests__/identity-under-wp-app-role.integration.test.ts,
-- which previously flagged this as a known gap).

GRANT DELETE ON mfa_recovery_codes TO wp_app;
