-- session-creds-upsert.sql (P07 Unit U4) - the canonical fence-predicated
-- creds save (STEP 4 of the phase task, strengthened per DECIDED FACT 2).
--
-- Zero rows is AMBIGUOUS by design (core invariant 2 / 3): it can mean
-- either "someone already wrote a newer cred_version" (an ordinary
-- optimistic-concurrency retry signal) or "this caller's fence is no longer
-- the live one" (a takeover already happened - this caller must self-fence
-- and stop, never retry). The two demand OPPOSITE actions, so this
-- statement alone cannot tell them apart - see pg-repo.ts's
-- `classifyWriteMiss`, which re-reads `instance_lease_state.current_fence`
-- and `cred_version` afterwards to decide which happened, with fence
-- mismatch WINNING when both are true.
--
-- INSERT arm: also fence-checked via `WHERE EXISTS (<lease subquery>)` - a
-- stale owner (one whose fence no longer matches `instance_lease_state.
-- current_fence`) must not be able to create row 1 for an instance that has
-- never been saved before either. expected_version = 0 is the sentinel for
-- "first save of a new instance" (no existing row): the INSERT branch's
-- `cred_version` starts at 1, the UPDATE arm's conflict branch has nothing
-- to compare expected_version against on that first save because the row
-- does not exist yet - the ON CONFLICT DO UPDATE below only ever fires once
-- a row already exists, so expected_version on the very first save is
-- informational (a caller must always pass 0) rather than enforced by SQL.
--
-- UPDATE arm: STRENGTHENED with `whatsapp_session_credentials.client_id =
-- <client id>` (P06 lesson, DECIDED FACT 2) - CLIENT_ID_PREDICATE needs a
-- real client_id comparison in every tenant-table statement, zero behavior
-- change for a legitimate writer (the row's client_id never differs from
-- the caller's tenant in practice; this only closes a theoretical
-- cross-tenant collision window). Also predicated on
-- `cred_version = <expected version>` (optimistic concurrency) AND
-- `owner_fence <= <fence>` AND the same lease-fence EXISTS subquery as the
-- INSERT arm (a stale owner's write must not silently "win" a race against
-- a fresher lease holder even if it still knows the right cred_version).
--
-- FIX-A CRITICAL-2 (released lease still authorises writes): the lease-fence
-- EXISTS subquery (both arms) ALSO requires `ls.owner_worker_id = $worker_id`
-- - a released or stolen lease (mint overwrites the PREVIOUS owner's
-- `owner_worker_id`; a clean release nulls it - see
-- `lease-mint-fence.sql`/`lease-release.sql`) fails this predicate even when
-- a stale in-memory fence value would otherwise still numerically match.
--
-- FIX-A CRITICAL-1(b) (epoch-blind writes / purge resurrection): BOTH arms
-- additionally require `EXISTS (SELECT 1 FROM whatsapp_instances wi WHERE
-- wi.id = $instance_id AND wi.client_id = $client_id AND wi.session_epoch =
-- $session_epoch)` - a write built at a pre-purge epoch can then never land,
-- even if it still holds a numerically-current fence (a purge bumps
-- `session_epoch` in the SAME transaction as its fence-gated deletes, so a
-- caller that has not observed the bump is provably stale).
--
-- `cred_version = whatsapp_session_credentials.cred_version + 1` on
-- conflict; `owner_fence = <fence>`; `session_epoch = <session epoch>`;
-- `updated_at = now()`. RETURNING cred_version.

-- name: session-creds-upsert
INSERT INTO whatsapp_session_credentials
  (instance_id, client_id, ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag,
   kek_id, enc_version, session_epoch, cred_version, owner_fence)
SELECT $instance_id, $client_id, $ciphertext, $iv, $auth_tag, $dek_wrapped, $dek_iv, $dek_tag,
       $kek_id, $enc_version, $session_epoch, 1, $fence
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
ON CONFLICT (instance_id) DO UPDATE
   SET ciphertext = $ciphertext,
       iv = $iv,
       auth_tag = $auth_tag,
       dek_wrapped = $dek_wrapped,
       dek_iv = $dek_iv,
       dek_tag = $dek_tag,
       kek_id = $kek_id,
       enc_version = $enc_version,
       session_epoch = $session_epoch,
       cred_version = whatsapp_session_credentials.cred_version + 1,
       owner_fence = $fence,
       updated_at = now()
 WHERE whatsapp_session_credentials.client_id = $client_id
   AND whatsapp_session_credentials.cred_version = $expected_version
   AND whatsapp_session_credentials.owner_fence <= $fence
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
RETURNING cred_version;
