-- wallet-reconcile.sql (P18 Unit U8a) - the wallet reconciler's own query
-- surface: seven cross-tenant READ-ONLY sections (each a 1:1 passthrough of
-- a `SECURITY DEFINER` function from migration 0053, executed as
-- `wp_scheduler` - same idiom as `reconcile-unresolved.sql`/
-- `reap-expired-leases.sql`), the rollup upsert, the finding insert, the
-- daily correction-count guard, and ONE money-writing statement.
--
-- THIS FILE IS ONE OF THE FOUR SANCTIONED WRITERS of
-- `wallet_accounts.balance_minor` (`scripts/check-single-debit.ts`'s
-- `SINGLE_DEBIT_EXEMPT_PATHS`) - only the `wallet-adjustment-debit` section
-- below writes it; `scripts/check-single-debit.ts` is what enforces that no
-- other file in the repo may. Every OTHER section here is a bounded,
-- read-only cross-tenant scan; the two upsert/insert sections below
-- (`wallet-rollup-upsert`, `wallet-finding-insert`) run PER TENANT as
-- `wp_app` under the normal RLS path (`tenantDb.withTenant`), never
-- cross-tenant.
--
-- Registered in `scripts/registries/cross-tenant-queries.ts` under
-- `db/queries/wallet-reconcile.sql:<section>` for every cross-tenant
-- section (all seven `SELECT ... FROM wp_wallet_*` sections below).

-- name: wallet-reconcile-continuity
-- Check A. Bounded per-client (200 ledger rows max per client, enforced
-- inside the function body - never a full-ledger aggregate).
SELECT client_id, kind, detail, amount_minor
  FROM wp_wallet_check_continuity($limit);

-- name: wallet-reconcile-missing-debits
-- Check B. Acked/reconciled_sent attempts resolved in [$from, $to) with no
-- matching debit_send/adjustment_debit guard.
SELECT client_id, send_attempt_id, message_job_id, message_job_created_at, instance_id, job_status, resolved_at
  FROM wp_wallet_check_missing_debits($from, $to, $limit);

-- name: wallet-reconcile-orphan-debits
-- Check C. debit_send guards in [$from, $to) with no matching settled attempt.
SELECT client_id, send_attempt_id, ledger_seq, attempt_state
  FROM wp_wallet_check_orphan_debits($from, $to, $limit);

-- name: wallet-reconcile-rollup-parity
-- Check D. Persisted wallet_daily_summary vs. a fresh compute for $day.
SELECT client_id, instance_id, field, expected, actual
  FROM wp_wallet_check_rollup_parity($day, $limit);

-- name: wallet-reconcile-orphan-guards
-- Check E. Unstamped guards (ledger_seq = 0) older than 10 minutes - the
-- one-transaction debit's own canary (should be structurally impossible).
SELECT client_id, send_attempt_id, kind, created_at
  FROM wp_wallet_check_orphan_guards($limit);

-- name: wallet-rollup-compute
-- One UTC day of one monthly wallet_ledger partition, grouped by
-- (client_id, instance_id) - never a full-ledger aggregate.
SELECT client_id, instance_id, sent_count, debit_minor, credit_minor, refund_minor
  FROM wp_wallet_rollup_compute($day, $limit);

-- name: wallet-count-empty-clients
-- Platform gauge, no parameters.
SELECT wp_wallet_count_empty_clients() AS clients_empty;

-- name: wallet-rollup-upsert
-- Per tenant, as wp_app under tenantDb.withTenant - not cross-tenant. A
-- re-run with unchanged figures touches zero rows (the WHERE ... IS
-- DISTINCT FROM guard).
INSERT INTO wallet_daily_summary (client_id, day, instance_id, sent_count, debit_minor, credit_minor, refund_minor, updated_at)
VALUES ($client_id, $day, $instance_id, $sent_count, $debit_minor, $credit_minor, $refund_minor, now())
ON CONFLICT (client_id, day, instance_id) DO UPDATE
  SET sent_count = EXCLUDED.sent_count,
      debit_minor = EXCLUDED.debit_minor,
      credit_minor = EXCLUDED.credit_minor,
      refund_minor = EXCLUDED.refund_minor,
      updated_at = now()
 WHERE (wallet_daily_summary.sent_count, wallet_daily_summary.debit_minor, wallet_daily_summary.credit_minor, wallet_daily_summary.refund_minor)
       IS DISTINCT FROM (EXCLUDED.sent_count, EXCLUDED.debit_minor, EXCLUDED.credit_minor, EXCLUDED.refund_minor)
-- client_id = $client_id
;

-- name: wallet-finding-insert
-- Per tenant, as wp_app under tenantDb.withTenant - not cross-tenant.
INSERT INTO wallet_reconcile_findings (client_id, kind, detail, amount_minor, corrected_at)
VALUES ($client_id, $kind, $detail::jsonb, $amount_minor, $corrected_at)
RETURNING id
-- client_id = $client_id
;

-- name: wallet-reconcile-daily-correction-count
-- Per tenant, as wp_app under tenantDb.withTenant - not cross-tenant. Caps
-- how many reconciliation corrections check B may apply per client per UTC
-- day.
SELECT count(*)::int AS n
  FROM wallet_ledger
 WHERE client_id = $client_id
   AND kind = 'adjustment_debit'
   AND reason = 'reconciliation'
   AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

-- name: wallet-adjustment-debit
-- THE ONLY MONEY WRITE IN THIS FILE. The capped check-B correction - same
-- guard-first chain as `debit-send.sql`'s `debit-repaired-send`, with three
-- differences: the `job` CTE accepts any settled attempt state
-- ('acked'/'reconciled_sent') with NO `j.status` requirement (the
-- reconciler is correcting a charge gap, not confirming a fresh send); the
-- guard/ledger kind is 'adjustment_debit'; and the ledger row carries
-- reason = 'reconciliation', actor_type = 'system'. Callers stamp the
-- guard's ledger_seq via `debit-send.sql`'s `wallet-stamp-guard` section
-- with kind = 'adjustment_debit' (same second-statement idiom - a
-- data-modifying CTE cannot see its own newly-inserted guard row).
WITH job AS (
  SELECT j.id, j.created_at, j.client_id, j.instance_id, j.campaign_id
    FROM send_attempts a
    JOIN message_jobs j ON j.id = a.message_job_id AND j.created_at = a.message_job_created_at
   WHERE a.id = $attempt AND a.client_id = $client AND j.client_id = $client
     AND a.state IN ('acked', 'reconciled_sent')),
guard AS (
  INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
  SELECT $attempt, 'adjustment_debit', u.client_id, 0, u.created_at FROM job u
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
                             send_attempt_id, actor_type, reason)
  SELECT a.client_id, a.entry_seq, 'adjustment_debit', -$rate, a.balance_minor, $price_key, $rate,
         u.instance_id, u.campaign_id, u.id, u.created_at, $attempt, 'system', 'reconciliation'
    FROM acct a JOIN job u ON u.client_id = a.client_id
  RETURNING seq)
SELECT (SELECT count(*) FROM job)::int AS job_rows,
       (SELECT count(*) FROM guard)::int AS guard_rows,
       (SELECT seq FROM ins)::text AS seq;
