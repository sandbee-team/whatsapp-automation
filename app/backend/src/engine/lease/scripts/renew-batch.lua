-- renew-batch.lua (P06 Unit U4) - compare-and-extend liveness for N lease
-- keys in exactly ONE round trip (ADR 0018 S4 / scope-delta row 2: a
-- per-lease renew loop is forbidden at 1,000+ concurrent sessions - see
-- lease-state-repo.ts's renewBatch header for the Postgres-side twin of this
-- rule). Every key is checked against its OWN expected `worker|fence` value
-- before being extended - a key whose value no longer matches (expired,
-- taken over, or never acquired) is left untouched and reported as 0.
--
-- KEYS[i]    = lease key i
-- ARGV[1]    = leaseTtlMs (shared TTL for every key renewed this call)
-- ARGV[1+i]  = expected `worker|fence` value for KEYS[i]
--
-- Returns a 0/1 array positionally aligned with KEYS.
local ttlMs = ARGV[1]
local out = {}

for i, key in ipairs(KEYS) do
  local expected = ARGV[1 + i]
  if redis.call('GET', key) == expected then
    redis.call('PEXPIRE', key, ttlMs)
    out[i] = 1
  else
    out[i] = 0
  end
end

return out
