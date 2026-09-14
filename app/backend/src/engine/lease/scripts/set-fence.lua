-- set-fence.lua (P06 Unit U4) - compare-and-set the minted Postgres fence
-- onto the placeholder acquire.lua staked. If the key no longer holds OUR
-- `workerId|PENDING` placeholder (expired, or raced away), this aborts
-- without writing anything - the caller no longer holds the key and must
-- not proceed (core invariant 2: never proceed on an unclear state).
--
-- KEYS[1] = lease key
-- ARGV[1] = workerId
-- ARGV[2] = fence
-- ARGV[3] = leaseTtlMs
--
-- Returns 1 and sets the key to `workerId|fence` (PX ttlMs) on success;
-- returns 0 (no write) when the placeholder no longer matches.
if redis.call('GET', KEYS[1]) ~= (ARGV[1] .. '|PENDING') then
  return 0
end

redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
return 1
