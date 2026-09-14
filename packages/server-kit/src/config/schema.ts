import { z } from 'zod';

/**
 * Purpose-separated KEKs (single authority) - see data-security design §4.3.
 * P01 step 7's `src/crypto/purposes.ts` re-exports `KEK_PURPOSES` from here;
 * nothing else in the workspace re-declares this list.
 *
 * `optout-pepper` (P14 Unit U3): its key material is an HMAC pepper, used
 * DIRECTLY as HMAC-SHA256 key bytes (`platform/crypto/phone-hash.ts`'s
 * `hashRecipient`) - never for envelope sealing (`seal()`/`open()`), and
 * therefore never wrapped/rotated the way the other three purposes are.
 * This key must NEVER be retired or rotated: rotating it would silently
 * orphan every stored `opt_outs.phone_hash`, `message_jobs.recipient_hash`,
 * and `recipient_send_buckets.phone_hash` - each is a lookup key, not
 * ciphertext, so there is no "still opens under the old key" recovery path
 * the way envelope rotation has for `session`/`tenant-secrets`/`user-secrets`.
 *
 * `api-key-pepper` (go-live session, Unit U1, `db/migrations/0076_api_keys.sql`):
 * used DIRECTLY as HMAC-SHA256 key bytes over a presented API key's secret
 * (`api_keys.secret_hash`), same "pepper, not envelope-sealed material"
 * shape as `optout-pepper` above, and for the same reason: a stored
 * `secret_hash` is a lookup/compare value, not ciphertext, so there is no
 * "still opens under the old key" rotation path - rotating this pepper would
 * invalidate every previously issued API key's hash at once.
 */
export const KEK_PURPOSES = [
  'session',
  'tenant-secrets',
  'user-secrets',
  'optout-pepper',
  'api-key-pepper',
] as const;

export type KekPurpose = (typeof KEK_PURPOSES)[number];

const kekPurposeSchema = z.enum(KEK_PURPOSES);

/**
 * Pino's level table - `WP_LOG_LEVEL` must be one of these (see step 4's
 * logger, which trusts this schema and never re-validates).
 */
const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Splits a comma-separated `WP_KEK_PURPOSES` value into a deduplicated,
 * validated list. Rejects empty entries (e.g. a trailing comma) and unknown
 * purposes - both are caught by the `.check` below.
 */
const kekPurposesListSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(kekPurposeSchema).min(1))
  .transform((purposes) => Object.freeze([...new Set(purposes)]) as readonly KekPurpose[]);

/**
 * The Zod schema for every environment variable this process reads.
 * `config/index.ts` is the only place this schema is ever parsed - see the
 * module doc comment there for the "parsed once, frozen" contract.
 */
export const configSchema = z.object({
  WP_ENV: z.enum(['development', 'test', 'production']),
  WP_LOG_LEVEL: z.enum(PINO_LEVELS),
  WP_KEY_RING_PATH: z.string().min(1),
  WP_KEK_PURPOSES: kekPurposesListSchema,
  WP_ENC_VERSION: z.coerce.number().int().positive(),
});

export type Config = z.infer<typeof configSchema>;
