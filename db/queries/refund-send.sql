-- refund-send.sql (P18 Unit U4) - the reversal half of the guard-first
-- money seam (ADR 0019 S7; ADR 0038 S5). One section:
--
--   refund-send  - reverses a `debit_send` charge for one `send_attempt_id`,
--                  ONLY IF a `debit_send` guard with `ledger_seq > 0`
--                  exists for that attempt. Nothing else refunds:
--                  delivered-but-unread, blocked recipient, and
--                  after-ack undeliverable are never refund-eligible - a
--                  charge that already happened for a message that reached
--                  the provider stays charged.
--
-- (a) THIS FILE (together with `debit-send.sql`/`wallet-reconcile.sql`/
--     `wallet-signup-credit.sql`) IS THE ONLY WRITER of
--     `wallet_accounts.balance_minor` and of `wallet_ledger` rows -
--     `scripts/check-single-debit.ts` enforces this repo-wide; this file is
--     exempt by path.
--
-- (b) GUARD-FIRST, same discipline as `debit-send.sql`: CTE `deb` reads the
--     debit guard + its ledger row (the amount to reverse comes from THAT
--     ledger row's `rate_minor`, never a re-resolved price - a price-list
--     change between debit and refund must never change the refunded
--     amount). CTE `guard` inserts the `refund_send` guard row FIRST, keyed
--     `(send_attempt_id, 'refund_send')` - its `RETURNING` gates the account
--     UPDATE, exactly as `debit-send.sql`'s own `guard` CTE gates `acct`. A
--     replay (guard INSERT does nothing via `ON CONFLICT ... DO NOTHING`)
--     commits no account update and no ledger row - `acct`/`ins` are both
--     driven `FROM guard`.
--
-- (c) NO DEBIT, NO REFUND: `deb` requires a `debit_send` guard row with
--     `ledger_seq > 0` for `$attempt` - an attempt that was never charged
--     (e.g. `reconciled_lost` for a `dispatched`-but-never-`acked` attempt,
--     the common case today) produces zero rows from `deb`, so `guard`/
--     `acct`/`ins` all produce zero rows too - a correct, silent no-op, not
--     an error.
--
-- (d) `frozen` is ABSORBING in the refund's `state` CASE too - a refund
--     never unfreezes a wallet (only an explicit unfreeze action does, out
--     of this file's scope), mirroring `debit-send.sql`'s own (d).
--
-- (e) LOCK ORDER: `wallet_charge_guards`/`wallet_ledger` (read, via `deb`)
--     -> `wallet_accounts` (UPDATE) - the debit guard/ledger rows are only
--     ever READ here, never written; `wallet_accounts` is the only table
--     this file's `acct` CTE writes.
--
-- (f) The refund guard's `created_at` is ALWAYS the ORIGINAL debit guard's
--     `created_at` (`deb.created_at`) - same partition row family as the
--     debit it reverses, never `now()` - mirrors `debit-send.sql`'s own (f)
--     for the same reason (a late refund for an old attempt must land on
--     that attempt's original partition).
--
-- `client_id = $client` is threaded through every CTE (never inferred from
-- the guard/ledger rows alone) so a cross-tenant `$attempt` collision can
-- never leak a refund across tenants.
--
-- Same two-statement shape as `debit-send.sql`: this file's `refund-send`
-- PLUS `debit-send.sql`'s `wallet-stamp-guard` (reused here with
-- `$kind = 'refund_send'`) stamp the guard's `ledger_seq` in a second
-- statement, same transaction - a data-modifying CTE cannot see its own
-- newly-inserted row.

-- name: refund-send
WITH deb AS (
  SELECT g.client_id, g.created_at, l.rate_minor, l.price_key, l.instance_id, l.campaign_id,
         l.message_job_id, l.message_job_created_at
    FROM wallet_charge_guards g
    JOIN wallet_ledger l ON l.client_id = g.client_id AND l.seq = g.ledger_seq
   WHERE g.send_attempt_id = $attempt AND g.kind = 'debit_send' AND g.client_id = $client AND g.ledger_seq > 0),
guard AS (
  INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
  SELECT $attempt, 'refund_send', d.client_id, 0, d.created_at FROM deb d
  ON CONFLICT (send_attempt_id, kind, created_at) DO NOTHING
  RETURNING send_attempt_id, client_id),
acct AS (
  UPDATE wallet_accounts w
     SET balance_minor        = w.balance_minor + d.rate_minor,
         lifetime_debit_minor = w.lifetime_debit_minor - d.rate_minor,
         entry_seq            = w.entry_seq + 1,
         state = CASE WHEN w.state = 'frozen' THEN 'frozen'          -- frozen is ABSORBING
                      WHEN w.balance_minor + d.rate_minor < w.max_rate_minor THEN 'empty'
                      WHEN w.balance_minor + d.rate_minor < w.low_balance_threshold_minor THEN 'low'
                      ELSE 'active' END::wallet_state,
         updated_at = now()
    FROM guard g JOIN deb d ON d.client_id = g.client_id
   WHERE w.client_id = g.client_id
  RETURNING w.client_id, w.entry_seq, w.balance_minor),
ins AS (
  INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor,
                             instance_id, campaign_id, message_job_id, message_job_created_at,
                             send_attempt_id, actor_type, reason)
  SELECT a.client_id, a.entry_seq, 'refund_send', d.rate_minor, a.balance_minor, d.price_key, d.rate_minor,
         d.instance_id, d.campaign_id, d.message_job_id, d.message_job_created_at, $attempt, 'system', 'reconciled_lost'
    FROM acct a JOIN deb d ON d.client_id = a.client_id
  RETURNING seq)
SELECT (SELECT count(*) FROM deb)::int AS debit_rows,
       (SELECT count(*) FROM guard)::int AS guard_rows,
       (SELECT seq FROM ins)::text AS seq;
