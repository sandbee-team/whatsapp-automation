-- wallet-state-warned.sql (P19 Unit U4, step 6) - the storage-layer once-
-- per-24h authority for the `wallet_low` notification, plus the transition-
-- identity stamp for `wallet_empty`. Writes ONLY two `wallet_accounts`
-- timestamp columns (`last_low_warning_at`, `last_empty_at`) - never the
-- money column, never the append-only entry table - so
-- `scripts/check-single-debit.ts`'s scan (see that guard's own header for
-- the exact bypass shapes it bans) does not match this file at all; it
-- needs no path exemption.
--
-- Both statements are the storage-layer idempotency authority (core
-- invariant 3) for their own concern - `state-notifier.ts` calls `notify()`
-- ONLY when the relevant statement's RETURNING produced a row, never on an
-- in-memory "have I warned recently" check.

-- name: wallet-low-warn-gate
-- Conditional UPDATE: succeeds (returns a row) only when this client has
-- never been warned, or was last warned >= 24h ago. A second crossing
-- within the same 24h window matches zero rows and RETURNING is empty -
-- state-notifier.ts's caller then skips notify() entirely for that credit.
-- Same statement written both the state check AND the write (no separate
-- read-then-write - the WHERE clause IS the gate).
UPDATE wallet_accounts
   SET last_low_warning_at = now()
 WHERE client_id = $client
   AND (last_low_warning_at IS NULL OR last_low_warning_at < now() - interval '24 hours')
 RETURNING last_low_warning_at::text AS last_low_warning_at;

-- name: wallet-empty-stamp
-- Unconditional stamp of the empty-transition's own identity (`last_empty_at`)
-- - this is NOT a dedupe gate by itself (a repeat empty-crossing before the
-- notifications_dedupe_uq unique constraint would reject a duplicate
-- `wallet:empty:{client}:{last_empty_at}` key only if last_empty_at is
-- unchanged; each genuine new empty-crossing gets a fresh now() value here,
-- so each is its own transition and notifies once). RETURNING gives the
-- caller the exact stamp to pass as notify()'s transitionId - never a
-- wall-clock read taken separately at notify() call time (dedupe-key.ts's
-- own "never a wall-clock value" rule - this IS the transition's own stored
-- identity, read back from the row that wrote it).
UPDATE wallet_accounts
   SET last_empty_at = now()
 WHERE client_id = $client
 RETURNING last_empty_at::text AS last_empty_at;
