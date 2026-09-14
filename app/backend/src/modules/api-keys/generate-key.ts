import { randomBytes } from 'node:crypto';

/**
 * generate-key.ts (api-keys U2) - tenant API key generation + strict
 * parsing. Format: `wp_live_<prefix12>_<secret64hex>` where `prefix12` is 12
 * lowercase hex chars (goes in the `api_keys.key_prefix` column, globally
 * unique, and is what the panel displays to identify a key) and
 * `secret64hex` is 32 bytes of `randomBytes` output as hex (never persisted
 * in the clear - only its HMAC digest via `hash.ts` is stored).
 *
 * MIRRORS `modules/webhooks/service.ts#generateSecret` / its own
 * `generate-secret.test.ts`: entropy is drawn directly from `randomBytes`,
 * never from concatenating `randomUUID()` values, because a UUIDv4 spends 6
 * of its 128 bits on fixed version/variant markers instead of entropy - for
 * key material that waste is avoidable by calling `randomBytes` directly.
 */

const PREFIX_HEX_CHARS = 12;
const SECRET_HEX_CHARS = 64;

export interface GeneratedApiKey {
  /** The full one-time key a customer sees, e.g. in the create response. */
  key: string;
  /** `wp_live_<prefix12>` - what is stored in `api_keys.key_prefix` and shown thereafter. */
  keyPrefix: string;
  /** The 64-hex-char secret half - never stored in the clear (see `hash.ts`). */
  secret: string;
  /** Last 4 chars of `secret`, stored alongside the hash for display (e.g. "...ab12"). */
  last4: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix12 = randomBytes(PREFIX_HEX_CHARS / 2).toString('hex');
  const secret = randomBytes(SECRET_HEX_CHARS / 2).toString('hex');
  const keyPrefix = `wp_live_${prefix12}`;

  return {
    key: `${keyPrefix}_${secret}`,
    keyPrefix,
    secret,
    last4: secret.slice(-4),
  };
}

export interface ParsedApiKey {
  keyPrefix: string;
  secret: string;
}

// Anchored end-to-end: no partial match, no trailing/leading slack. Exactly
// one underscore separates the prefix half from the secret half.
const API_KEY_PATTERN = /^(wp_live_[0-9a-f]{12})_([0-9a-f]{64})$/;

/** Strictly parses a presented key into its two halves, or `null` for ANY deviation from the exact documented shape (wrong prefix, wrong lengths, case, whitespace, embedded newlines, extra separators). */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(presented);
  if (!match) {
    return null;
  }
  const [, keyPrefix, secret] = match;
  if (!keyPrefix || !secret) {
    return null;
  }
  return { keyPrefix, secret };
}
