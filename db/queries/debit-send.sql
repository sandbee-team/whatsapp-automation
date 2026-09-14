-- debit-send.sql (P18 Unit U3) - the guard-first debit, ADR 0019 S2 + ADR
-- 0038 amendments. Three named sections:
--
--   debit-send          - the normal send-result path, chained off the
--                          `message_jobs` job-outcome UPDATE itself
--                          (`result.ts`'s `resolveAck`).
--   debit-repaired-send  - the reaper/reconciler repair path for a job
--                          `result.ts` never got to charge (chained off a
--                          SELECT of the attempt+job instead of the UPDATE).
--   wallet-stamp-guard   - the second statement, same transaction, that
--                          stamps the guard row's `ledger_seq` once the
--                          ledger row exists.
--
-- (a) THIS FILE IS THE ONLY WRITER of `wallet_accounts.balance_minor` for
--     sends and of `debit_send` `wallet_ledger` rows - `scripts/
--     check-single-debit.ts` enforces this repo-wide.
--
-- (b) The guard row is inserted FIRST (CTE `guard`), and its `RETURNING`
--     gates the account UPDATE - never `balance + (SELECT ... FROM ins)`.
--     An empty scalar subquery is NULL; a replay (guard INSERT does nothing
--     via ON CONFLICT) would then null the balance instead of leaving it
--     untouched.
--
-- (c) Everything downstream is chained off `upd`'s (or, in the repair
--     section, `job`'s) `RETURNING` - a zero-row job UPDATE
--     (`claim_lost_during_send`, another worker owns the job now) commits
--     no guard, no account update, no ledger row. A replayed call (the
--     guard INSERT's `ON CONFLICT ... DO NOTHING` yields zero rows from
--     `guard`) equally commits no account update and no ledger row - `acct`
--     and `ins` are both driven `FROM guard`.
--
-- (d) `frozen` is ABSORBING - it is the FIRST branch of the account's
--     `state` CASE, so a frozen wallet never flips back to active/low/empty
--     as a side effect of a debit (a debit still runs against a frozen
--     wallet - ADR 0019 - only new claims are blocked by `frozen`, in
--     `claim-jobs.sql`, not an in-flight charge).
--
-- (e) LOCK ORDER: message_jobs -> send_attempts -> wallet_accounts
--     (-> campaign_counters, once P23 adds that table). Every statement
--     below acquires locks in this order; do not reorder.
--
-- (f) The guard's `created_at` is ALWAYS `u.created_at` / `j.created_at` -
--     the CHARGED JOB's OWN `created_at`, never `now()` (ADR 0038 SS1) - a
--     late repair for a job created last month must land on that job's
--     original partition, or a crossed-month repair could charge the same
--     send twice (two different partitions, two different guard rows).
--
-- (g) The delta text below is verbatim except three ADR 0038 amendments:
--     the job UPDATE predicate matches P11's exact shape (id/lease_id/
--     status/client_id), the SELECT wrapper is `(SELECT ... )::type`
--     rather than a bare column list, and every `created_at` bind is taken
--     IN-STATEMENT from the row being charged, never a JS Date bind
--     (microsecond loss - see `dispatch.ts`'s own header for the same
--     trap).
--
-- Two statements are needed per charge (this file's `debit-send`/
-- `debit-repaired-send` PLUS `wallet-stamp-guard`): the guard row inserted
-- in CTE `guard` cannot be UPDATEd in the SAME statement (a data-modifying
-- CTE cannot see its own newly-inserted row), so the `ledger_seq` stamp is
-- a second statement in the same transaction as the debit.

-- name: debit-send
WITH upd AS (
  UPDATE message_jobs SET status = 'sent', sent_at = now(), terminal_at = now(), updated_at = now()
   WHERE id = $jid AND lease_id = $lease AND status = 'processing' AND client_id = $client
  RETURNING id, created_at, client_id, instance_id, campaign_id),
guard AS (
  INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
  SELECT $attempt, 'debit_send', u.client_id, 0, u.created_at FROM upd u
  ON CONFLICT (send_attempt_id, kind, created_at) DO NOTHING
  RETURNING send_attempt_id, client_id),
acct AS (
  UPDATE wallet_accounts w
     SET balance_minor        = w.balance_minor - $rate,
         lifetime_debit_minor = w.lifetime_debit_minor + $rate,
         entry_seq            = w.entry_seq + 1,
         state = CASE WHEN w.state = 'frozen' THEN 'frozen'          -- frozen is ABSORBING
                      WHEN w.balance_minor - $rate < w.max_rate_minor THEN 'empty'
                      WHEN w.balance_minor - $rate < w.low_balance_threshold_minor THEN 'low'
                      ELSE 'active' END::wallet_state,
         updated_at = now()
    FROM guard g WHERE w.client_id = g.client_id
  RETURNING w.client_id, w.entry_seq, w.balance_minor),
ins AS (
  INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor,
                             instance_id, campaign_id, message_job_id, message_job_created_at,
                             send_attempt_id, actor_type)
  SELECT a.client_id, a.entry_seq, 'debit_send', -$rate, a.balance_minor, $price_key, $rate,
         u.instance_id, u.campaign_id, u.id, u.created_at, $attempt, 'system'
    FROM acct a JOIN upd u ON u.client_id = a.client_id
  RETURNING seq)
SELECT (SELECT count(*) FROM upd)::int AS job_rows,
       (SELECT count(*) FROM guard)::int AS guard_rows,
       (SELECT seq FROM ins)::text AS seq;

-- name: debit-repaired-send
-- Same guard-first chain for a job the reaper/reconciler already repaired
-- to 'sent' (charger + reconciler check B) - result.ts never charged it
-- because the crash/loss happened before its own job-outcome UPDATE ever
-- ran. Chained off a SELECT of the attempt+job instead of the job UPDATE;
-- requires the attempt to be in a settled state and the job to already be
-- 'sent' (the repair itself, not this statement, is what got it there).
WITH job AS (
  SELECT j.id, j.created_at, j.client_id, j.instance_id, j.campaign_id
    FROM send_attempts a
    JOIN message_jobs j ON j.id = a.message_job_id AND j.created_at = a.message_job_created_at
   WHERE a.id = $attempt AND a.client_id = $client AND j.client_id = $client
     AND a.state IN ('acked', 'reconciled_sent') AND j.status = 'sent'),
guard AS (
  INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
  SELECT $attempt, 'debit_send', u.client_id, 0, u.created_at FROM job u
  ON CONFLICT (send_attempt_id, kind, created_at) DO NOTHING
  RETURNING send_attempt_id, client_id),
acct AS (
  UPDATE wallet_accounts w
     SET balance_minor        = w.balance_minor - $rate,
         lifetime_debit_minor = w.lifetime_debit_minor + $rate,
         entry_seq            = w.entry_seq + 1,
         state = CASE WHEN w.state = 'frozen' THEN 'frozen'          -- frozen is ABSORBING
                      WHEN w.balance_minor - $rate < w.max_rate_minor THEN 'empty'
                      WHEN w.balance_minor - $rate < w.low_balance_threshold_minor THEN 'low'
                      ELSE 'active' END::wallet_state,
         updated_at = now()
    FROM guard g WHERE w.client_id = g.client_id
  RETURNING w.client_id, w.entry_seq, w.balance_minor),
ins AS (
  INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor,
                             instance_id, campaign_id, message_job_id, message_job_created_at,
                             send_attempt_id, actor_type)
  SELECT a.client_id, a.entry_seq, 'debit_send', -$rate, a.balance_minor, $price_key, $rate,
         u.instance_id, u.campaign_id, u.id, u.created_at, $attempt, 'system'
    FROM acct a JOIN job u ON u.client_id = a.client_id
  RETURNING seq)
SELECT (SELECT count(*) FROM job)::int AS job_rows,
       (SELECT count(*) FROM guard)::int AS guard_rows,
       (SELECT seq FROM ins)::text AS seq;

-- name: wallet-stamp-guard
-- Same transaction as the debit that produced $seq. No created_at bind
-- (microsecond trap, see header (f)): the (send_attempt_id, kind) prefix
-- probes each partition's PK; ledger_seq = 0 makes this a no-op on replay
-- (a replayed debit's guard INSERT already returned zero rows, so this
-- statement is simply never reached a second time for the same attempt -
-- see result.ts/charge.ts callers).
UPDATE wallet_charge_guards SET ledger_seq = $seq
 WHERE send_attempt_id = $attempt AND kind = $kind AND client_id = $client AND ledger_seq = 0;
