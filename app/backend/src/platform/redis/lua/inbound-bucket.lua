-- inbound-bucket.lua (P21 Unit U5, step 6) - classic token bucket for the
-- per-instance inbound admission ceiling, stored as a hash {tokens, ts}.
--
-- KEYS[1] = bucket key (tenantKey(env, clientId, 'inbound', 'i', instanceId))
-- ARGV[1] = capacity (max tokens the bucket can hold)
-- ARGV[2] = refillPerMinute (tokens added per 60_000ms of elapsed time)
-- ARGV[3] = nowMs (caller-injected clock - never redis.call('TIME'), so the
--           unit test stays deterministic and this script never depends on
--           the Redis server's own clock)
-- ARGV[4] = ttlMs (PEXPIRE applied after every write, admit or shed)
--
-- On first sight of a key (no existing hash) tokens start at capacity (a
-- fresh instance is not penalised for having no prior history). Otherwise
-- tokens are refilled from the elapsed time since the last write, capped at
-- capacity. If at least one token is available after refill, one token is
-- taken and this returns 1 (admit); otherwise the refilled state is still
-- written back (so elapsed time is never lost) and this returns 0 (shed).
local capacity = tonumber(ARGV[1])
local refillPerMinute = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
else
  local elapsedMs = nowMs - ts
  if elapsedMs > 0 then
    tokens = math.min(capacity, tokens + (elapsedMs * refillPerMinute / 60000))
  end
  ts = nowMs
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  return 1
else
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  return 0
end
