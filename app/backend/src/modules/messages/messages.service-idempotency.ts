import type { CreateMessageServiceResult } from './messages.service.js';
import { IdempotencyKeyReusedError } from './messages.service.js';

/**
 * messages.service-idempotency.ts (P24 C2 fix round, Fix 2) - the
 * idempotency-replay pre-check `createMessage` runs BEFORE the group/opt-out
 * eligibility lookup, split into its own sibling module so
 * `messages.service.ts` (already at the 300-line cap) did not have to grow.
 * api.md rule 2: a replay of an already-used `Idempotency-Key` must return
 * the ORIGINAL resource - even if the recipient (a group, in particular)
 * has since become ineligible between the original call and the replay.
 * Fails CLOSED on a request-hash mismatch (key reuse with a different body,
 * unchanged 409 contract), same as the post-enqueue replay branch this
 * mirrors.
 */
export function replayResultFor(
  existing: { publicId: string; requestHash: Buffer | null } | undefined,
  requestHash: Buffer,
  warning: 'INSTANCE_OFFLINE' | undefined,
): CreateMessageServiceResult | undefined {
  if (!existing) {
    return undefined;
  }
  if (!existing.requestHash || !existing.requestHash.equals(requestHash)) {
    throw new IdempotencyKeyReusedError();
  }
  return { id: existing.publicId, status: 'queued', ...(warning ? { warning } : {}) };
}
