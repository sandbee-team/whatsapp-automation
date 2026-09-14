-- reconcile-optout-mirror.sql (P20 Unit U7, step 8) - the nightly mirror
-- reconciler's per-client sweep statement. Same derivation as
-- `modules/contacts/optout-mirror.ts`'s `syncOptOutMirror` (single-contact,
-- called inside recordOptOut/restoreOptOut), scoped instead to EVERY live
-- contact for one client and BOUNDED by $limit (ADR 0018 S4 - never an
-- unbounded per-sweep scan). Repairs ONLY `contacts` - never writes
-- `opt_outs` (see optout-mirror.test.ts's static proof).
--
-- KEYSET-PAGE INTERACTION (P20 C1 n3, documented not fixed - benign,
-- deliberate): a repaired row's `updated_at = now()` moves it within the
-- `(updated_at, id)` keyset the contacts list/export routes page on
-- (`contacts.repo.ts`/`export.ts`). If this nightly repair runs while a
-- caller's keyset export/list is mid-walk, a row it already-or-not-yet
-- paged past can shift across page boundaries - it may appear on a LATER
-- page than expected, or be skipped between two pages, exactly like any
-- other concurrent UPDATE racing a keyset walk. This is the same class of
-- benign eventual-consistency gap every keyset pagination in this repo
-- already accepts (no OFFSET anywhere, canon) - never a correctness bug in
-- the reconciler itself, and never worth serialising a nightly maintenance
-- sweep against every in-flight export for.

-- name: reconcile-optout-mirror
WITH derived AS (
  SELECT c.id,
         EXISTS (
           SELECT 1 FROM opt_outs o
            WHERE o.client_id = $client_id AND o.phone_hash = c.phone_hash AND o.restored_at IS NULL
         ) AS live,
         (
           SELECT min(o.created_at) FROM opt_outs o
            WHERE o.client_id = $client_id AND o.phone_hash = c.phone_hash AND o.restored_at IS NULL
         ) AS first_at
    FROM contacts c
   WHERE c.client_id = $client_id AND c.deleted_at IS NULL
), drifted AS (
  SELECT d.id, d.live, d.first_at
    FROM derived d JOIN contacts c ON c.id = d.id AND c.client_id = $client_id
   WHERE (c.opt_out_state = 'opted_out') <> d.live OR c.opted_out_at IS DISTINCT FROM d.first_at
   LIMIT $limit
)
UPDATE contacts c
   SET opt_out_state = CASE WHEN d.live THEN 'opted_out'::contact_opt_out_state ELSE 'none'::contact_opt_out_state END,
       opted_out_at  = d.first_at,
       updated_at    = now()
  FROM drifted d
 WHERE c.id = d.id AND c.client_id = $client_id
RETURNING c.id;
