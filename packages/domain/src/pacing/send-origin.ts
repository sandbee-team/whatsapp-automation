/**
 * Send origin (P14 Unit U2, phase step 8 domain half; blueprint "pacing-
 * exempt system messages").
 *
 * `SendOrigin` distinguishes tenant-initiated sends (which always pace)
 * from platform-generated system messages (auto-replies, opt-out
 * confirmations) that must go out immediately regardless of pacing state -
 * core invariant 6 (no pacing-bypass surface) requires that distinction be
 * impossible for a tenant to set on their own send. This module only
 * carries the lowercase string literals and the pure partition/lookup
 * logic; `scripts/check-send-origin.ts` enforces that the two exempt
 * origins are never referenced by their (deliberately not written here)
 * uppercase identifier form outside `app/backend/src/modules/pacing/
 * internal/` - do not add such an identifier to this file.
 */

export const SEND_ORIGINS = [
  'campaign',
  'api_send',
  'inbox_manual',
  'system_reply',
  'opt_out_confirmation',
] as const;

export type SendOrigin = (typeof SEND_ORIGINS)[number];

/** Never paced, gated, or deferred - system-generated, not tenant-initiated. */
export const EXEMPT_ORIGINS = Object.freeze(['system_reply', 'opt_out_confirmation'] as const);

/** Always subject to pacing/deny-reason evaluation - every tenant-initiated send. */
export const NON_EXEMPT_ORIGINS = Object.freeze(['campaign', 'api_send', 'inbox_manual'] as const);

export function isExemptOrigin(origin: SendOrigin): boolean {
  return (EXEMPT_ORIGINS as readonly string[]).includes(origin);
}
