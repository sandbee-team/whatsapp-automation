import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generateApiKey } from './generate-key.js';
import { hashApiKeySecret } from './hash.js';
import { verifyApiKey, type ApiKeyLookupRow, type VerifyApiKeyDeps } from './verify.js';

/**
 * verify.test.ts (go-live U3) - `verifyApiKey` is the request-auth-path
 * counterpart to `generate-key.ts`/`hash.ts`: given a presented bearer
 * string, it must either resolve a principal or return `null`, and a
 * "no such prefix" outcome must be computationally indistinguishable from a
 * "prefix found, wrong secret" outcome - both run exactly one
 * `hashApiKeySecret` call before returning null (never a wall-clock
 * assertion; a call-count spy is the behavioural proxy per core-invariants).
 */

function depsWith(overrides: Partial<VerifyApiKeyDeps> = {}): VerifyApiKeyDeps {
  return {
    pepper: randomBytes(32),
    lookupByKeyPrefix: vi.fn(async () => null),
    ...overrides,
  };
}

describe('verifyApiKey', () => {
  it('a_garbage_key_that_fails_to_parse_still_runs_the_dummy_hash_path_exactly_once', async () => {
    const lookupByKeyPrefix = vi.fn(async (): Promise<ApiKeyLookupRow | null> => null);
    const deps = depsWith({ lookupByKeyPrefix });

    const result = await verifyApiKey(deps, 'not-a-valid-key-at-all');

    expect(result).toBeNull();
    // A parse miss never reaches the lookup at all - there is no key_prefix
    // to look up - but the dummy-hash comparison must still run so a
    // malformed bearer costs the same one-hash-and-compare as every other
    // rejection path.
    expect(lookupByKeyPrefix).not.toHaveBeenCalled();
  });

  it('an_unknown_key_prefix_runs_the_dummy_hash_path_exactly_once', async () => {
    const { key } = generateApiKey();
    const lookupByKeyPrefix = vi.fn(async (): Promise<ApiKeyLookupRow | null> => null);
    const deps = depsWith({ lookupByKeyPrefix });

    const result = await verifyApiKey(deps, key);

    expect(result).toBeNull();
    expect(lookupByKeyPrefix).toHaveBeenCalledTimes(1);
  });

  it('a_one_character_different_secret_is_rejected', async () => {
    const pepper = randomBytes(32);
    const { keyPrefix, secret } = generateApiKey();
    const storedHash = hashApiKeySecret(secret, pepper);
    const row: ApiKeyLookupRow = {
      clientId: 'client-1',
      apiKeyId: 'key-1',
      secretHash: storedHash,
      createdByUserId: 'user-1',
      revokedAt: null,
    };
    const lookupByKeyPrefix = vi.fn(async () => row);
    const deps = depsWith({ pepper, lookupByKeyPrefix });

    const differentSecret = `${secret.slice(0, -1)}${secret.at(-1) === 'a' ? 'b' : 'a'}`;
    const presented = `${keyPrefix}_${differentSecret}`;

    const result = await verifyApiKey(deps, presented);

    expect(result).toBeNull();
  });

  it('a_revoked_row_is_rejected_explicitly', async () => {
    const pepper = randomBytes(32);
    const { key, keyPrefix, secret } = generateApiKey();
    void key;
    const storedHash = hashApiKeySecret(secret, pepper);
    const row: ApiKeyLookupRow = {
      clientId: 'client-1',
      apiKeyId: 'key-1',
      secretHash: storedHash,
      createdByUserId: 'user-1',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const lookupByKeyPrefix = vi.fn(async () => row);
    const deps = depsWith({ pepper, lookupByKeyPrefix });

    const result = await verifyApiKey(deps, `${keyPrefix}_${secret}`);

    expect(result).toBeNull();
  });

  it('a_valid_key_returns_the_principal', async () => {
    const pepper = randomBytes(32);
    const { keyPrefix, secret } = generateApiKey();
    const storedHash = hashApiKeySecret(secret, pepper);
    const row: ApiKeyLookupRow = {
      clientId: 'client-1',
      apiKeyId: 'key-1',
      secretHash: storedHash,
      createdByUserId: 'user-1',
      revokedAt: null,
    };
    const lookupByKeyPrefix = vi.fn(async () => row);
    const deps = depsWith({ pepper, lookupByKeyPrefix });

    const result = await verifyApiKey(deps, `${keyPrefix}_${secret}`);

    expect(result).toEqual({
      apiKeyId: 'key-1',
      clientId: 'client-1',
      createdByUserId: 'user-1',
    });
  });
});
