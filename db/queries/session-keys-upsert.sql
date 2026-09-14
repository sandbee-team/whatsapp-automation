-- session-keys-upsert.sql (P07 Unit U4) - batched fence-predicated UPSERT of
-- `whatsapp_session_keys` rows, one statement per `setKeys` call (never a
-- per-key loop - same "batch, not loop" class as lease-renew-batch.sql).
-- `unnest(...)` over parallel arrays supplies one row per (key_type, key_id)
-- pair; every row carries the SAME caller-held `$fence` (a single `setKeys`
-- call is scoped to one instance, one fence - see pg-repo.ts).
--
-- Every three predicates from the phase's canonical rule apply: tenant
-- (client_id = $client_id), fence (owner_fence <= $fence on conflict), and
-- lease-fence EXISTS (both INSERT and UPDATE arms - a stale owner must not
-- create or touch a durable key row either).
--
-- FIX-B SUGGESTION-7 (symmetry with session-creds-upsert.sql): BOTH arms
-- additionally require `EXISTS (SELECT 1 FROM whatsapp_instances wi WHERE
-- wi.id = $instance_id AND wi.client_id = $client_id AND wi.session_epoch =
-- $session_epoch)` - the same epoch-blind-write guard creds writes already
-- have (FIX-A CRITICAL-1(b)). A keys write built at a pre-purge epoch can
-- then never land either, even if it still holds a numerically-current
-- fence. `classifyWriteMiss`'s epoch comparison (`pg-repo.ts`) stays the
-- zero-row disambiguator for both creds and keys misses - this predicate
-- only adds storage-layer enforcement to match it.
--
-- RETURNING key_id: the caller compares `result.rows.length` against the
-- number of rows it asked to write to detect a partial/zero-row miss
-- (pg-repo.ts's setKeys reports `missed: true` when they differ).

-- name: session-keys-upsert
INSERT INTO whatsapp_session_keys
  (instance_id, client_id, key_type, key_id, ciphertext, iv, auth_tag,
   dek_wrapped, dek_iv, dek_tag, kek_id, enc_version, owner_fence)
SELECT $instance_id, $client_id, t.key_type, t.key_id, t.ciphertext, t.iv, t.auth_tag,
       t.dek_wrapped, t.dek_iv, t.dek_tag, t.kek_id, t.enc_version, $fence
  FROM unnest(
    $key_types::text[], $key_ids::text[], $ciphertexts::bytea[], $ivs::bytea[],
    $auth_tags::bytea[], $dek_wrappeds::bytea[], $dek_ivs::bytea[], $dek_tags::bytea[],
    $kek_ids::text[], $enc_versions::int[]
  ) AS t(key_type, key_id, ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag, kek_id, enc_version)
 WHERE EXISTS (
   SELECT 1 FROM instance_lease_state ls
    WHERE ls.instance_id = $instance_id
      AND ls.client_id = $client_id
      AND ls.current_fence = $fence
      AND ls.owner_worker_id = $worker_id
 )
   AND EXISTS (
     SELECT 1 FROM whatsapp_instances wi
      WHERE wi.id = $instance_id
        AND wi.client_id = $client_id
        AND wi.session_epoch = $session_epoch
   )
ON CONFLICT (instance_id, key_type, key_id) DO UPDATE
   SET ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       dek_wrapped = EXCLUDED.dek_wrapped,
       dek_iv = EXCLUDED.dek_iv,
       dek_tag = EXCLUDED.dek_tag,
       kek_id = EXCLUDED.kek_id,
       enc_version = EXCLUDED.enc_version,
       owner_fence = $fence,
       updated_at = now()
 WHERE whatsapp_session_keys.client_id = $client_id
   AND whatsapp_session_keys.owner_fence <= $fence
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
   AND EXISTS (
     SELECT 1 FROM whatsapp_instances wi
      WHERE wi.id = $instance_id
        AND wi.client_id = $client_id
        AND wi.session_epoch = $session_epoch
   )
RETURNING key_id;
