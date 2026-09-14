-- session-creds-classify-miss.sql (P07 Unit U4, extended FIX-A CRITICAL-1/2)
-- - the re-read `classifyWriteMiss` runs after a zero-row
-- `session-creds-upsert.sql`. Read-only, tenant-scoped, no fence predicate (a
-- miss classification must see the CURRENT lease fence regardless of which
-- fence the failed write used - that is the whole point of the re-read).
-- LEFT JOINs because a never-leased instance (no instance_lease_state row at
-- all) is still a valid, classifiable case (pg-repo.ts's classifyWriteMiss
-- treats a NULL `current_fence`/`owner_worker_id` the same as a fence
-- mismatch: 'fence_conflict').
--
-- Also reads `owner_worker_id` (CRITICAL-2: a released/stolen lease's
-- `owner_worker_id` no longer matches the caller's worker id even if
-- `current_fence` still numerically matches) and `whatsapp_instances.
-- session_epoch` (CRITICAL-1(c): distinguishes a fresh 'epoch_conflict' from
-- an ordinary 'version_conflict' once fence+owner both check out).

-- name: session-creds-classify-miss
SELECT c.cred_version AS cred_version,
       ls.current_fence AS current_fence,
       ls.owner_worker_id AS owner_worker_id,
       wi.session_epoch AS instance_session_epoch
  FROM (SELECT $instance_id::uuid AS instance_id, $client_id::uuid AS client_id) probe
  LEFT JOIN whatsapp_session_credentials c
    ON c.instance_id = probe.instance_id AND c.client_id = probe.client_id
  LEFT JOIN instance_lease_state ls
    ON ls.instance_id = probe.instance_id AND ls.client_id = probe.client_id
  LEFT JOIN whatsapp_instances wi
    ON wi.id = probe.instance_id AND wi.client_id = probe.client_id;
