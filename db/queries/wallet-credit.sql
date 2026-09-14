-- wallet-credit.sql (P19 Unit U2, step 4) - the guard-first credit
-- statement: staff-approved top-ups (topup_manual), promo credits
-- (promo_credit), and staff goodwill/correction credits (adjustment_credit).
-- refund_send is NOT a credit-statement kind here - it belongs to
-- db/queries/refund-send.sql and this file must never write it.
--
-- Three named sections, same guard-first shape as db/queries/debit-send.sql
-- (that file's own header is the fuller reference; only the deltas below):
--
--   wallet-credit-ext-ref     - the chicken-and-egg fix. wallet_ledger_ext_
--                                refs (client_id, external_ref, seq,
--                                created_at) is the GLOBAL external_ref
--                                idempotency authority (migration 0004),
--                                but seq cannot be known before it is
--                                allocated. This section inserts the
--                                ext-ref row FIRST with a placeholder
--                                seq = 0, gated by ON CONFLICT DO NOTHING -
--                                a replay (same client_id+external_ref)
--                                yields zero rows here and the whole chain
--                                (acct, ins, all driven FROM ext_ref)
--                                commits nothing. client_id is threaded
--                                explicitly as a bind, never inferred from
--                                the ext-ref row alone, so a cross-tenant
--                                external_ref collision cannot leak a
--                                credit into the wrong wallet.
--
--   wallet-credit-stamp-ext-ref - second statement, SAME transaction as the
--                                credit that produced $seq: stamps the real
--                                seq onto the ext-ref row (a data-modifying
--                                CTE cannot see its own newly-inserted row,
--                                so this cannot be folded into the first
--                                section - identical two-statement idiom to
--                                debit-send.sql's wallet-stamp-guard). A
--                                no-op on replay: ledger_seq = 0 only
--                                matches the row this credit itself just
--                                inserted.
--
--   (acct/ins CTEs live inside wallet-credit-ext-ref's single statement,
--   chained off ext_ref's RETURNING - never `balance + (SELECT ... FROM
--   ins)`, which yields NULL on replay, same trap debit-send.sql's header
--   documents.)
--
-- state CASE: byte-identical in SHAPE to debit-send.sql's, frozen FIRST
-- (absorbing) - this is the SQL half of packages/domain/src/wallet/
-- state.ts's nextWalletState, which both statements must agree with
-- (asserted in packages/domain/test/wallet-state.test.ts and
-- app/backend/src/modules/wallet/credit.integration.test.ts). The only
-- difference from the debit's CASE is the arithmetic direction: this one
-- goes UP (`balance_minor + $amount`), the debit goes DOWN. A credit after
-- an overdraft absorbs the negative balance - there is NO
-- CHECK (balance_minor >= 0) on wallet_accounts and this file must never
-- add one (ADR 0019).
--
-- Exempted by path in scripts/check-single-debit.ts's
-- SINGLE_DEBIT_EXEMPT_PATHS, the fifth sanctioned writer alongside
-- debit-send.sql, refund-send.sql, wallet-reconcile.sql and
-- wallet-signup-credit.sql.
--
-- Replay contract: on replay, wallet-credit-ext-ref's ext_ref/acct/ins CTEs
-- all yield zero rows (no money moves, no new ledger row) - the caller
-- (credit.repo.ts) then runs a SEPARATE READ statement
-- (wallet-credit-existing-seq) to fetch the already-stamped seq for
-- (client_id, external_ref) and returns it with replayed: true. A read
-- does not violate the guard-first rule.

-- name: wallet-credit-ext-ref
WITH ext_ref AS (
  INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq)
  VALUES ($client, $external_ref, 0)
  ON CONFLICT (client_id, external_ref) DO NOTHING
  RETURNING client_id, external_ref),
acct AS (
  UPDATE wallet_accounts w
     SET balance_minor          = w.balance_minor + $amount,
         lifetime_credit_minor  = w.lifetime_credit_minor + $amount,
         entry_seq              = w.entry_seq + 1,
         state = CASE WHEN w.state = 'frozen' THEN 'frozen'          -- frozen is ABSORBING
                      WHEN w.balance_minor + $amount < w.max_rate_minor THEN 'empty'
                      WHEN w.balance_minor + $amount < w.low_balance_threshold_minor THEN 'low'
                      ELSE 'active' END::wallet_state,
         updated_at = now()
    FROM ext_ref e WHERE w.client_id = e.client_id AND w.client_id = $client
  RETURNING w.client_id, w.entry_seq, w.balance_minor),
ins AS (
  INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor,
                              actor_type, actor_staff_id, reason, external_ref)
  SELECT a.client_id, a.entry_seq, $kind, $amount, a.balance_minor,
         'staff', $staff_id, $reason, $external_ref
    FROM acct a
  RETURNING seq)
SELECT (SELECT count(*) FROM ext_ref)::int AS ext_ref_rows,
       (SELECT count(*) FROM acct)::int AS acct_rows,
       (SELECT seq FROM ins)::text AS seq;

-- name: wallet-credit-stamp-ext-ref
-- Same transaction as the credit that produced $seq. The WHERE ... AND
-- seq = 0 predicate makes this a no-op on replay (a replayed credit's
-- ext_ref INSERT already returned zero rows, so this statement is simply
-- never reached a second time for the same (client_id, external_ref) - see
-- credit.repo.ts).
UPDATE wallet_ledger_ext_refs SET seq = $seq
 WHERE client_id = $client AND external_ref = $external_ref AND seq = 0;

-- name: wallet-credit-existing-seq
-- READ-ONLY: fetches the already-stamped seq for a replayed (client_id,
-- external_ref) pair. Never a write - the guard-first rule only binds the
-- CREDIT path above.
SELECT seq::text AS seq FROM wallet_ledger_ext_refs
 WHERE client_id = $client AND external_ref = $external_ref;
