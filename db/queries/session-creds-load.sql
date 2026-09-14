-- session-creds-load.sql (P07 Unit U4) - read-only load of the one
-- `whatsapp_session_credentials` row for an instance. Tenant-scoped
-- (client_id predicate) but deliberately carries NO fence predicate: a load
-- is not a write, so there is nothing to protect against a stale owner here
-- (a stale worker reading is harmless; only its WRITES are fence-gated, in
-- session-creds-upsert.sql).

-- name: session-creds-load
SELECT ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag, kek_id, enc_version,
       cred_version, session_epoch
  FROM whatsapp_session_credentials
 WHERE instance_id = $instance_id
   AND client_id = $client_id;
