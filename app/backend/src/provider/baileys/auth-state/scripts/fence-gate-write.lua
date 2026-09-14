-- fence-gate-write.lua (P07 FIX-A WARNING-3) - atomic fence-gated write of
-- ONE Signal auth-state hash. Closes the check-then-write TOCTOU: `store-
-- keys.ts`'s pre-check (a `classifyWriteMiss` re-read against
-- `instance_lease_state`) proves the caller's fence was current AT THE TIME
-- OF THE CHECK, but a takeover minting a NEW fence could land in the window
-- between that check and this write. This script makes the fence check AND
-- the write atomic by keeping a monotonic high-water-mark "gate" value in
-- Redis itself (a per-instance key holding the highest fence any caller has
-- ever successfully gated through), so the write only ever lands if the
-- caller's fence is still `>=` that high-water mark - a stale caller whose
-- fence was superseded by a mint that already gated a NEWER fence through is
-- rejected here even though it saw a stale but locally-cached fence.
--
-- The fence is deliberately NOT part of the hash key itself (that would
-- orphan a live Signal record's decryptability on every takeover - ADR 0018
-- S5) - it lives only in this separate gate key, consulted before every
-- write, never used to construct the hash key.
--
-- KEYS[1] = gate key (tenantKey(env, clientId, 'sig'|'cache', 'i', instanceId, 'fence'))
-- KEYS[2] = hash key (the actual Signal/rebuildable key-type hash being written)
-- ARGV[1] = fence (the caller's fence, as a string)
-- ARGV[2] = gate TTL ms (30d)
-- ARGV[3] = hash TTL ms (SIGNAL_KEY_TTL_MS)
-- ARGV[4] = number of field/value SET pairs (n)
-- ARGV[5 .. 4+2n] = n (field, value) pairs to HSET on the hash
-- ARGV[5+2n] = number of fields to HDEL (m)
-- ARGV[6+2n .. 5+2n+m] = m field names to HDEL from the hash
--
-- Returns 1 on a successful gated write; returns 0 (no write performed at
-- all - neither the gate nor the hash is touched) when the caller's fence is
-- STRICTLY LESS than the stored gate value (a newer owner already gated a
-- higher fence through).
local gateKey = KEYS[1]
local hashKey = KEYS[2]
local fence = tonumber(ARGV[1])
local gateTtlMs = ARGV[2]
local hashTtlMs = ARGV[3]
local setCount = tonumber(ARGV[4])

local stored = redis.call('GET', gateKey)
if stored ~= false and tonumber(stored) > fence then
  return 0
end

redis.call('SET', gateKey, ARGV[1])
redis.call('PEXPIRE', gateKey, gateTtlMs)

local argIndex = 5
if setCount > 0 then
  local setArgs = {}
  for _ = 1, setCount do
    table.insert(setArgs, ARGV[argIndex])
    table.insert(setArgs, ARGV[argIndex + 1])
    argIndex = argIndex + 2
  end
  redis.call('HSET', hashKey, unpack(setArgs))
end

local delCount = tonumber(ARGV[argIndex])
argIndex = argIndex + 1
if delCount > 0 then
  local delArgs = {}
  for _ = 1, delCount do
    table.insert(delArgs, ARGV[argIndex])
    argIndex = argIndex + 1
  end
  redis.call('HDEL', hashKey, unpack(delArgs))
end

redis.call('PEXPIRE', hashKey, hashTtlMs)

return 1
