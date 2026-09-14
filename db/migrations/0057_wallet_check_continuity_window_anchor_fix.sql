-- P18 fix-round F1 (reviewer MAJOR-1) — migration 0057: the checkpoint
-- anchor in wp_wallet_check_continuity (migration 0055) read the ledger's
-- GLOBALLY oldest row (`SELECT … FROM wallet_ledger WHERE client_id = …
-- ORDER BY seq ASC LIMIT 1`, i.e. always seq 1) instead of the oldest row OF
-- THE SAME 200-ROW BOUNDED WINDOW the continuity-break loop already reads.
-- `oldest.seq = v.checkpoint_seq + 1` therefore only ever fired for a client
-- whose entire ledger history is under 200 rows; once a client crosses 200
-- ledger entries and a checkpoint has been cut, the seam between
-- `checkpoint_balance_minor` and the window's oldest row was silently never
-- validated (MAJOR-1). The named test also only asserted the row-cap
-- literal's presence as a substring of the function body (MAJOR-2), so this
-- shape of bug could not be caught behaviourally.
--
-- Fix: compute the window ONCE (`recent`, the same 200-row-max, per-client,
-- descending-seq-then-cap read migration 0055 already used for the
-- continuity-break loop), then derive prev_seq/prev_bal (lag) from that
-- SAME bounded CTE while walking it in
-- ascending seq order; oldest/newest are captured as plain scalar variables
-- from the FIRST and EVERY row of that single walk (never a second scan, and
-- never a field-by-field assignment into an unassigned RECORD, which raises
-- "record is not assigned yet" in plpgsql). Every column is table-qualified;
-- the outer loop variable (`v`) and inner loop variable (`w`) stay distinct
-- exactly as migration 0055 fixed.
--
-- Semantics preserved exactly:
--  - continuity_break on `seq <> prev_seq + 1` or
--    `balance_after <> prev_bal + amount` for any row inside the window
--    (unchanged from 0055).
--  - checkpoint-anchored continuity_break: when `v.checkpoint_seq > 0 AND
--    window_oldest.seq = v.checkpoint_seq + 1`, assert
--    `window_oldest.balance_after = v.checkpoint_balance_minor +
--    window_oldest.amount` — now the window's oldest row instead of the
--    ledger's globally oldest row. `detail.anchored_on = 'checkpoint'`.
--  - balance_mismatch on the window's newest `balance_after <>
--    v.balance_minor`, or (no ledger rows at all) `v.balance_minor <>
--    v.checkpoint_balance_minor`.
--  - entry_seq_drift (continuity_break) when `v.entry_seq <> COALESCE(window
--    newest seq, v.checkpoint_seq)`.
--
-- Migrations are forward-only: 0053-0056 are already applied to the
-- persistent dev DB and are never edited; this file fully restates the
-- function (CREATE OR REPLACE), signature, ownership, and grants.

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
  w RECORD;
  oldest_seq bigint;
  oldest_amount_minor bigint;
  oldest_balance_after_minor bigint;
  newest_seq bigint;
  newest_balance_after_minor bigint;
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
    oldest_seq := NULL;
    oldest_amount_minor := NULL;
    oldest_balance_after_minor := NULL;
    newest_seq := NULL;
    newest_balance_after_minor := NULL;

    -- Bounded per-client read: at most the 200 most recent ledger rows for
    -- THIS client (never an aggregate over the full ledger - test-pinned:
    -- this function's body must never contain the token s-u-m openparen).
    -- This is the single bounded-window read this function performs.
    -- `oldest_*`/`newest_*` scalars are captured while walking THIS SAME
    -- bounded `recent` window in ascending seq order (first row = oldest,
    -- every row overwrites newest so the last row = newest) - never a
    -- second scan over wallet_ledger, and never a field-by-field assignment
    -- into an unassigned RECORD. This inner loop uses its own variable `w`
    -- (never `v`, the outer loop's variable).
    FOR w IN
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
      IF oldest_seq IS NULL THEN
        oldest_seq := w.seq;
        oldest_amount_minor := w.amount_minor;
        oldest_balance_after_minor := w.balance_after_minor;
      END IF;
      newest_seq := w.seq;
      newest_balance_after_minor := w.balance_after_minor;

      IF w.prev_seq IS NOT NULL
         AND (w.seq <> w.prev_seq + 1 OR w.balance_after_minor <> w.prev_bal + w.amount_minor)
      THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', w.seq, 'prev_seq', w.prev_seq,
          'expected', w.prev_bal + w.amount_minor, 'actual', w.balance_after_minor
        );
        amount_minor := w.balance_after_minor - (w.prev_bal + w.amount_minor);
        RETURN NEXT;
      END IF;
    END LOOP;

    IF oldest_seq IS NOT NULL AND v.checkpoint_seq > 0 AND oldest_seq = v.checkpoint_seq + 1 THEN
      IF oldest_balance_after_minor <> v.checkpoint_balance_minor + oldest_amount_minor THEN
        client_id := v.client_id;
        kind := 'continuity_break';
        detail := jsonb_build_object(
          'seq', oldest_seq, 'anchored_on', 'checkpoint',
          'expected', v.checkpoint_balance_minor + oldest_amount_minor, 'actual', oldest_balance_after_minor
        );
        amount_minor := oldest_balance_after_minor - (v.checkpoint_balance_minor + oldest_amount_minor);
        RETURN NEXT;
      END IF;
    END IF;

    IF newest_seq IS NOT NULL THEN
      IF newest_balance_after_minor <> v.balance_minor THEN
        client_id := v.client_id;
        kind := 'balance_mismatch';
        detail := jsonb_build_object(
          'ledger_balance', newest_balance_after_minor, 'account_balance', v.balance_minor,
          'max_seq', newest_seq, 'entry_seq', v.entry_seq
        );
        amount_minor := v.balance_minor - newest_balance_after_minor;
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

    IF v.entry_seq <> COALESCE(newest_seq, v.checkpoint_seq) THEN
      client_id := v.client_id;
      kind := 'continuity_break';
      detail := jsonb_build_object(
        'reason', 'entry_seq_drift', 'entry_seq', v.entry_seq,
        'max_seq', COALESCE(newest_seq, v.checkpoint_seq)
      );
      amount_minor := 0;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.wp_wallet_check_continuity(int) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_wallet_check_continuity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_wallet_check_continuity(int) TO wp_scheduler;
