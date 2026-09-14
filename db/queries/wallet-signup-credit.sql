-- wallet-signup-credit.sql (P18 Unit U7b) - the signup-credit ledger row -
-- the ONLY non-send ledger writer in v1 until P19's top-up path adds its
-- own sanctioned file.
--
-- (1) Runs inside the signup transaction (`modules/identity/signup.service.ts`),
--     as `wp_app`, immediately after `wallet_accounts` is inserted with
--     `entry_seq = 1` - this statement writes the matching `seq = 1` ledger
--     row (ADR 0019 §1: "the signup transaction must provision a wallet").
--     `wallet_accounts.entry_seq` MUST equal the highest `wallet_ledger.seq`
--     for the client at all times: `db/queries/debit-send.sql` allocates its
--     next ledger row at `entry_seq + 1`, so a signup-time mismatch would
--     collide on the ledger's `(client_id, seq, created_at)` primary key on
--     the very first paid send.
--
-- (2) Append-only - this row is never UPDATEd or DELETEd afterward.
--
-- (3) Exempted by path in `scripts/check-single-debit.ts`'s
--     `SINGLE_DEBIT_EXEMPT_PATHS` alongside `debit-send.sql`,
--     `refund-send.sql` and `wallet-reconcile.sql` - those three own every
--     `wallet_ledger` write from a send/refund/reconciliation path; this one
--     file owns the single provisioning-time credit.
INSERT INTO wallet_ledger
  (client_id, seq, kind, amount_minor, balance_after_minor, quantity, actor_type, actor_user_id, external_ref)
VALUES ($client_id, $seq, $kind, $amount_minor, $balance_after_minor, $quantity, $actor_type, $actor_user_id, $external_ref)
-- client_id = $client_id
