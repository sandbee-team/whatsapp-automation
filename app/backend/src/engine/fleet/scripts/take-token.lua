-- take-token.lua (P09 Unit U2 step 4) - atomic continuous-refill token take
-- for the fleet-wide connect bucket. Bucket capacity == rate (one second of
-- tokens), so observed connects/s can never exceed the configured rate even
-- under concurrent, cross-worker demand.
--
-- Refill uses Redis server TIME (never a per-worker clock) so every worker
-- in the fleet computes IDENTICAL refill math against the SAME bucket -
-- clock skew between workers can never cause the bucket to over- or
-- under-refill from one worker's point of view vs another's.
--
-- KEYS[1] = bucket hash key (fields: tokens, lastRefillMs)
-- ARGV[1] = ratePerSec (also the bucket capacity)
-- ARGV[2] = ttlMs (bucket key expiry - keeps an idle bucket from lingering forever)
--
-- Returns 1 if a token was taken, 0 if the bucket was empty.
local rate = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local lastRefillMs = tonumber(redis.call('HGET', KEYS[1], 'lastRefillMs'))

if tokens == nil or lastRefillMs == nil then
  tokens = rate
  lastRefillMs = nowMs
end

local elapsedMs = nowMs - lastRefillMs
if elapsedMs > 0 then
  tokens = math.min(rate, tokens + (elapsedMs * rate) / 1000)
  lastRefillMs = nowMs
end

local taken = 0
if tokens >= 1 then
  tokens = tokens - 1
  taken = 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'lastRefillMs', tostring(lastRefillMs))
redis.call('PEXPIRE', KEYS[1], ttlMs)

return taken
