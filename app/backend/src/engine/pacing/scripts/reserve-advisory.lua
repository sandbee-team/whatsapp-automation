-- reserve-advisory.lua (P13 Unit U4, step 8) - the Redis pre-filter ahead
-- of the Postgres reserve. Can NEVER grant: it returns 1 ("ask Postgres")
-- far more often than it needs to, and 0 ("definitely not eligible - skip
-- the Postgres round-trip") only when the mirrored counter has ALREADY hit
-- the mirrored cap. Postgres remains the sole authority (core invariant 3);
-- this script exists purely to avoid a wasted round-trip when the answer
-- is already obviously no.
--
-- KEYS[1] = mirror counter key (tenantKey(env, clientId, 'pacing', 'mirror',
--            'i', instanceId, 'd', ledgerDate) - built by advisory.ts, never
--            here)
-- ARGV[1] = dailyCap (the eff_daily_cap mirror ceiling; a NON-POSITIVE or
--            missing value means "no known cap" - always returns 1)
-- ARGV[2] = expireAtUnixSeconds (next local midnight - EXPIREAT target so a
--            forgotten key can never accumulate across days)
--
-- Returns 1 ("ask Postgres") when the key is absent (nothing mirrored yet -
-- degrade to asking Postgres, never to skipping it) or when the current
-- mirrored count is STILL BELOW dailyCap. Returns 0 ONLY when the mirrored
-- count has already reached or passed dailyCap - i.e. the one case where
-- skipping Postgres is safe because Postgres would deny too (mod normal
-- mirror lag, which is why Postgres is asked again once the mirror
-- disagrees - see postgres_is_authoritative_when_redis_is_wrong).
local dailyCap = tonumber(ARGV[1])
if dailyCap == nil or dailyCap <= 0 then
  return 1
end

local current = redis.call('GET', KEYS[1])
if current == false then
  return 1
end

local count = tonumber(current)
if count == nil then
  return 1
end

if count >= dailyCap then
  return 0
end

return 1
