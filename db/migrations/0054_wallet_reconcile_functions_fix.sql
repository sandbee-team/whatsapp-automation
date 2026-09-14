-- P18 fix-round (debugger) — migration 0054: 42702 ambiguous column in
-- wp_wallet_check_continuity, root-caused against real Postgres by
-- db/tests/wallet-reconcile-definer-exec.test.ts (0053's own definer test,
-- wallet-reconcile-definer.test.ts, never EXECUTED the function - it only
-- greps `pg_get_functiondef`, so U8a shipped this bug green).
--
-- wp_wallet_check_continuity's `RETURNS TABLE (client_id uuid, kind text,
-- detail jsonb, amount_minor bigint)` makes `amount_minor` a PL/pgSQL
-- variable (the OUT parameter) inside the function body. 0053's inner
-- windowed-read subquery selected a BARE `amount_minor` column from
-- `wallet_ledger` (`SELECT seq, amount_minor, balance_after_minor FROM
-- public.wallet_ledger …`, twice: the base-window CTE-equivalent subquery
-- and the standalone `oldest` lookup) - PL/pgSQL cannot tell whether that
-- name means the table column or the OUT variable, so Postgres raises
-- `ERROR 42702: column reference "amount_minor" is ambiguous` at EXECUTION
-- time (not at CREATE time - the function body is only parsed, not
-- resolved, when created). Every other 0053 function was checked for the
-- same class (any bare column equal to an OUT column name) and is clean -
-- functions 2/3/6 SELECT only table-aliased columns (`a.`, `g.`, `j.`),
-- function 4 aliases every column `l.`, function 5 draws from aliased CTEs
-- (`c.`/`s.`/`j.`) and literal text, function 7 is `count(*)` only. Only
-- function 1 needs this fix.
--
-- Fix: qualify EVERY column reference in the body (the house style already
-- used by functions 2-7), including inside the nested subqueries that were
-- previously bare. `CREATE OR REPLACE FUNCTION` keeps the existing OID/ACL,
-- but ownership/search_path/grants are restated explicitly below anyway,
-- per this schema's own convention (0053's header does the same for
-- migration 0027's precedent). Behavior, signature, `LIMIT 200`, and the
-- no-`sum(` property are all unchanged - only column qualification changed.
--
-- NOTE: executing this fixed function against seeded data (rather than only
-- inspecting `pg_get_functiondef`, as 0053's own definer test did) surfaced
-- a SECOND, independent latent bug in the same function body - a loop-
-- variable reuse producing `ERROR 42703: record "v" has no field
-- "client_id"`. That is fixed separately in migration 0055 (kept separate
-- because this file's checksum was already recorded against the dev
-- database by the first test run in this fix round - forward-only
-- discipline applies from the moment a migration is applied, even within
-- the same session).

CREATE OR REPLACE FUNCTION public.wp_wallet_check_continuity(p_limit int)
RETURNS TABLE (
  client_id    uuid,
  kind         text,
  detail       jsonb,
  amount_minor bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v RECORD;
  oldest RECORD;
  newest RECORD;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'wp_wallet_check_continuity: p_limit must be between 1 and 5000, got %', p_limit;
  END IF;

  FOR v IN
    SELECT a.client_id, a.balance_minor, a.entry_seq, a.checkpoint_seq, a.checkpoint_balance_minor
      FROM public.wallet_accounts a
     ORDER BY a.client_id
     LIMIT p_limit
  LOOP
    -- Bounded per-client read: at most the 200 most recent ledger rows for
    -- THIS client. Never an aggregate over the full ledger (test-pinned:
    -- this function's body must never contain the token s-u-m openparen).
    -- Every column below is table-qualified (`recent.`/`o.`) so none can
    -- collide with the OUT parameter `amount_minor` - the 42702 fix.
    FOR v IN
      SELECT o.seq, o.amount_minor, o.balance_after_minor, o.prev_seq, o.prev_bal
        FROM (
          SELECT recent.seq, recent.amount_minor, recent.balance_after_minor,
                 lag(recent.seq) OVER (ORDER BY recent.seq) AS prev_seq,
                 lag(recent.balance_after_minor) OVER (ORDER BY recent.seq) AS prev_bal
            FROM (
              SELECT wallet_ledger.seq, wallet_ledger.amount_minor, wallet_ledger.balance_after_minor
                FROM public.wallet_ledger
               WHERE wallet_ledger.client_id = v.client_id
               ORDER BY wallet_ledger.seq DESC
               LIMIT 200
            ) recent
        ) o
       ORDER BY o.seq
    LOOP
      IF v.prev_seq IS NOT NULL
         AND (v.seq <> v.prev_seq + 1 OR v.balance_after_minor <> v.prev_bal + v.amount_minor)
      THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', v.seq, 'prev_seq', v.prev_seq,
          'expected', v.prev_bal + v.amount_minor, 'actual', v.balance_after_minor
        );
        amount_minor := v.balance_after_minor - (v.prev_bal + v.amount_minor);
        RETURN NEXT;
      END IF;
    END LOOP;

    -- Re-read the bounded window's extremes (oldest/newest) once more for
    -- the checkpoint-anchored and balance/entry_seq checks below - a fresh
    -- bounded query, not an unbounded one. Table-qualified throughout.
    SELECT r.seq, r.amount_minor, r.balance_after_minor
      INTO oldest
      FROM (
        SELECT wallet_ledger.seq, wallet_ledger.amount_minor, wallet_ledger.balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY wallet_ledger.seq ASC
         LIMIT 1
      ) r;

    SELECT r.seq, r.balance_after_minor
      INTO newest
      FROM (
        SELECT wallet_ledger.seq, wallet_ledger.balance_after_minor
          FROM public.wallet_ledger
         WHERE wallet_ledger.client_id = v.client_id
         ORDER BY wallet_ledger.seq DESC
         LIMIT 1
      ) r;

    IF oldest.seq IS NOT NULL AND v.checkpoint_seq > 0 AND oldest.seq = v.checkpoint_seq + 1 THEN
      IF oldest.balance_after_minor <> v.checkpoint_balance_minor + oldest.amount_minor THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', oldest.seq, 'anchored_on', 'checkpoint',
          'expected', v.checkpoint_balance_minor + oldest.amount_minor, 'actual', oldest.balance_after_minor
        );
        amount_minor := oldest.balance_after_minor - (v.checkpoint_balance_minor + oldest.amount_minor);
        RETURN NEXT;
      END IF;
    END IF;

    IF newest.seq IS NOT NULL THEN
      IF newest.balance_after_minor <> v.balance_minor THEN
        client_id := v.client_id;
        kind := 'balance_mismatch';
        detail := jsonb_build_object(
          'ledger_balance', newest.balance_after_minor, 'account_balance', v.balance_minor,
          'max_seq', newest.seq, 'entry_seq', v.entry_seq
        );
        amount_minor := v.balance_minor - newest.balance_after_minor;
        RETURN NEXT;
      END IF;
    ELSE
      IF v.balance_minor <> v.checkpoint_balance_minor THEN
        client_id := v.client_id;
        kind := 'balance_mismatch';
        detail := jsonb_build_object(
          'ledger_balance', v.checkpoint_balance_minor, 'account_balance', v.balance_minor,
          'max_seq', v.checkpoint_seq, 'entry_seq', v.entry_seq
        );
        amount_minor := v.balance_minor - v.checkpoint_balance_minor;
        RETURN NEXT;
      END IF;
    END IF;

    IF v.entry_seq <> COALESCE(newest.seq, v.checkpoint_seq) THEN
      client_id := v.client_id;
      kind := 'continuity_break';
      detail := jsonb_build_object(
        'reason', 'entry_seq_drift', 'entry_seq', v.entry_seq,
        'max_seq', COALESCE(newest.seq, v.checkpoint_seq)
      );
      amount_minor := 0;
      RETURN NEXT;
    END IF;

    oldest := NULL;
    newest := NULL;
  END LOOP;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_continuity(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_continuity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_continuity(int) TO wp_scheduler;
