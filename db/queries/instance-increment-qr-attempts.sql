-- instance-increment-qr-attempts.sql (P08 Unit U4) - ENGINE write: bumps
-- `qr_attempts` by exactly 1 on each fresh QR code the engine surfaces
-- mid-pairing. Fence-guarded (same lease predicate family as every other
-- engine write here). RETURNING both `qr_attempts` (the caller's own
-- attempt-cap decision) and `pairing_started_at` (so the caller can also
-- evaluate the pairing-window timeout without a second round trip).

-- name: instance-increment-qr-attempts
UPDATE whatsapp_instances
   SET qr_attempts = qr_attempts + 1,
       updated_at = now()
 WHERE id = $instance_id
   AND client_id = $client_id
   AND EXISTS (
     SELECT 1 FROM instance_lease_state ls
      WHERE ls.instance_id = $instance_id
        AND ls.client_id = $client_id
        AND ls.current_fence = $fence
        AND ls.owner_worker_id = $worker_id
   )
RETURNING qr_attempts, pairing_started_at;
