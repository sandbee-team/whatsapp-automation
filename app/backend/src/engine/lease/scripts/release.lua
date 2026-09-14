-- release.lua (P06 Unit U4) - compare-and-delete. DEVIATION FROM OLDER CANON
-- (deliberate, recorded in the phase file): this leaves NO Redis "released"
-- marker behind. Graceful-release authority is Postgres's
-- `instance_lease_state.released_at` (see lease-release.sql / mintFence's
-- prevReleasedAt freshness check in lease-manager.ts) - Redis's job here is
-- only to stop being an obstacle to the NEXT acquire.lua NX check.
--
-- KEYS[1] = lease key
-- ARGV[1] = expected value (either `workerId|PENDING` for an aborted
--           acquire, or `workerId|fence` for a fully-owned lease)
--
-- Returns the DEL result (1 deleted / 0 nothing deleted) when the value
-- matches; returns 0 without deleting anything when it does not (we no
-- longer hold the key - deleting it would evict whoever holds it now).
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end

return 0
