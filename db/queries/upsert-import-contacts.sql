-- upsert-import-contacts.sql (P20 Unit U5, step 6) - the batched contact
-- import upsert. Runs inside the caller's `withTenant` transaction, one
-- statement per batch of parallel arrays (unnest), never one round trip per
-- row.
--
-- PARTIAL-INDEX GOTCHA (the phase's #1 gotcha, migration 0060's own header):
-- `contacts_client_phone_uq` is a PARTIAL unique index
-- (`WHERE deleted_at IS NULL`), so this statement's `ON CONFLICT` clause
-- MUST repeat `WHERE deleted_at IS NULL` - Postgres cannot infer a partial
-- index from a bare `ON CONFLICT (client_id, phone_e164)` and raises
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" otherwise.
--
-- OPT-OUT MIRROR, NEVER THE GATE (migration 0060's own header): the derived
-- `opt_out_state`/`opted_out_at` values join `opt_outs` through
-- `contacts.phone_hash = opt_outs.phone_hash` - the SAME hashed value both
-- tables store (one hasher, `platform/crypto/phone-hash.ts#hashRecipient`).
-- `opt_out_state`/`opted_out_at`/`import_id`/`source`/`consent_basis` are
-- NEVER present in the `DO UPDATE SET` list below: an import must never
-- clear an existing opt-out, and it must never change how/why a contact was
-- first created. Only `display_name` (COALESCE, never overwritten with a
-- blank), `attrs` (merged, never replaced) and `last_import_id` (migration
-- 0062 - the exact "which import last wrote this row" provenance the
-- cross-batch dedupe check reads, see `import-runner-cross-batch-dedupe.ts`)
-- update on a re-import.

-- name: upsert-import-contacts
WITH input AS (
  SELECT * FROM unnest(
    $phone_e164s::text[], $phone_hashes::bytea[], $wa_jids::text[],
    $display_names::text[], $attrs_list::jsonb[]
  ) AS t(phone_e164, phone_hash, wa_jid, display_name, attrs)
), upserted AS (
  INSERT INTO contacts (
    client_id, phone_e164, phone_hash, wa_jid, display_name, attrs, source,
    consent_basis, import_id, last_import_id, opt_out_state, opted_out_at, created_by_user_id
  )
  SELECT $client_id, i.phone_e164, i.phone_hash, i.wa_jid, i.display_name, i.attrs,
         'import', 'imported_with_attestation', $import_id, $import_id,
         CASE WHEN EXISTS (
           SELECT 1 FROM opt_outs o
            WHERE o.client_id = $client_id AND o.phone_hash = i.phone_hash AND o.restored_at IS NULL
         ) THEN 'opted_out'::contact_opt_out_state ELSE 'none'::contact_opt_out_state END,
         (SELECT min(o.created_at) FROM opt_outs o
           WHERE o.client_id = $client_id AND o.phone_hash = i.phone_hash AND o.restored_at IS NULL),
         $created_by_user_id
    FROM input i
  -- client_id = $client_id
  ON CONFLICT (client_id, phone_e164) WHERE deleted_at IS NULL
  DO UPDATE SET display_name   = COALESCE(EXCLUDED.display_name, contacts.display_name),
                attrs          = contacts.attrs || EXCLUDED.attrs,
                last_import_id = EXCLUDED.last_import_id,
                updated_at     = now()
  RETURNING id, phone_e164, opt_out_state, (xmax = 0) AS inserted
)
SELECT id, phone_e164, opt_out_state, inserted FROM upserted;
