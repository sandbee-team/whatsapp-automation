import { DUMMY_SECRET_HASH, verifyApiKeySecret } from './hash.js';
import { parseApiKey } from './generate-key.js';

/**
 * verify.ts (go-live U3) - the request-auth-path counterpart to
 * `generate-key.ts`/`hash.ts`. Looks up a presented API key's row via the
 * injected `lookupByKeyPrefix` (backed by U1's `wp_api_key_lookup`
 * SECURITY DEFINER function - see `route-policy.ts`'s `session_or_api_key`
 * policy for the caller), verifies its secret, and rejects a revoked row
 * EXPLICITLY (never filtered out by the lookup itself - the migration's own
 * doc comment is the source of that contract).
 *
 * Found/not-found indistinguishability: a parse miss OR a lookup miss both
 * still run exactly one `hashApiKeySecret` against `DUMMY_SECRET_HASH`
 * before returning `null`, so a garbage bearer costs the same one hash +
 * one constant-time compare as every other rejection path (mirrors
 * `hash.ts`'s own `DUMMY_SECRET_HASH` doc comment). No caching of any kind -
 * a cache would outlive a revoke.
 */

export interface ApiKeyLookupRow {
  clientId: string;
  apiKeyId: string;
  secretHash: Buffer;
  createdByUserId: string;
  revokedAt: Date | null;
}

export interface ApiKeyPrincipal {
  apiKeyId: string;
  clientId: string;
  createdByUserId: string;
}

export interface VerifyApiKeyDeps {
  /** The pepper backing `hashApiKeySecret`/`verifyApiKeySecret` - injected, never read from config here. */
  pepper: Buffer;
  /** Backed by U1's `wp_api_key_lookup(p_key_prefix text)` SECURITY DEFINER function. Returns `null` for no matching row (at most one - `key_prefix` is globally unique). */
  lookupByKeyPrefix: (keyPrefix: string) => Promise<ApiKeyLookupRow | null>;
}

/** Verifies a presented bearer string as an API key, or returns `null` for ANY rejection reason (parse miss, unknown prefix, wrong secret, revoked row) - never distinguishes which to the caller. */
export async function verifyApiKey(
  deps: VerifyApiKeyDeps,
  presented: string,
): Promise<ApiKeyPrincipal | null> {
  const parsed = parseApiKey(presented);
  if (!parsed) {
    return null;
  }

  const row = await deps.lookupByKeyPrefix(parsed.keyPrefix);
  if (!row) {
    // Found/not-found indistinguishability (see module doc comment): still
    // pay the one hash + compare even though there is nothing to compare
    // against a real row's hash.
    verifyApiKeySecret(parsed.secret, deps.pepper, DUMMY_SECRET_HASH);
    return null;
  }

  const verified = verifyApiKeySecret(parsed.secret, deps.pepper, row.secretHash);
  if (!verified) {
    return null;
  }

  if (row.revokedAt !== null) {
    return null;
  }

  return {
    apiKeyId: row.apiKeyId,
    clientId: row.clientId,
    createdByUserId: row.createdByUserId,
  };
}
