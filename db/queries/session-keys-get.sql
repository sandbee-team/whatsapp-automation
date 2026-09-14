-- session-keys-get.sql (P07 Unit U4) - batched read of requested
-- `whatsapp_session_keys` rows for one (instance, key_type), filtered to the
-- caller-supplied id list. Tenant-scoped, read-only (no fence predicate -
-- same reasoning as session-creds-load.sql: a read is not a write).

-- name: session-keys-get
SELECT key_id, ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag, kek_id, enc_version
  FROM whatsapp_session_keys
 WHERE instance_id = $instance_id
   AND client_id = $client_id
   AND key_type = $key_type
   AND key_id = ANY($key_ids::text[]);
