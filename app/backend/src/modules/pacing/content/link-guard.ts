import type { TenantQueryable } from '@wp/db';
import { containsLink, type GuardDecision } from '@wp/domain';

/**
 * link-guard.ts (P14 Unit U5, phase step 6) - `evaluateLinkGuard`: denies a
 * link in the FIRST message to a contact with no inbound reply yet, at the
 * low warm-up tiers.
 *
 * Group decision (documented): a group job has no `instance_recipient_
 * contacts` row (that table is keyed on a single contact's `recipient_
 * hash`, and a group has no "first contact" concept - the whole point of a
 * group is that many people, each with their own inbound history, share one
 * JID). Reading the canon literally ("link guard fires only against a
 * contact with no first_inbound_at") would make a group job ALWAYS fire,
 * which is wrong: a link-in-first-message guard is a first-CONTACT concept,
 * and groups have no first contact to protect. `isGroup` therefore skips
 * this guard entirely (`{ok:true}`) - content-level guards that ARE
 * meaningful for a group (blocked words) still apply via the sibling
 * `blocked-words.ts` evaluator, unaffected by this skip.
 */

export interface EvaluateLinkGuardInput {
  clientId: string;
  instanceId: string;
  recipientHash: Buffer;
  body: string;
  warmupTier: number;
  isGroup: boolean;
  now: Date;
  /** Fired at tier 3 (allowed, but flagged) - metrics wiring belongs to a later unit. */
  onWarn?: () => void;
}

export async function evaluateLinkGuard(
  tx: TenantQueryable,
  input: EvaluateLinkGuardInput,
): Promise<GuardDecision> {
  if (!containsLink(input.body)) {
    return { ok: true };
  }

  if (input.isGroup) {
    return { ok: true };
  }

  const result = await tx.query<{ first_inbound_at: Date | null }>(
    `SELECT first_inbound_at FROM instance_recipient_contacts
      WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3`,
    [input.clientId, input.instanceId, input.recipientHash],
  );
  const row = result.rows[0];

  // A contact that has ever replied is never blocked by this guard,
  // regardless of warm-up tier.
  if (row && row.first_inbound_at !== null) {
    return { ok: true };
  }

  if (input.warmupTier <= 2) {
    return { ok: false, reason: 'LINK_IN_FIRST_MESSAGE', retryAt: null };
  }

  if (input.warmupTier === 3) {
    input.onWarn?.();
    return { ok: true };
  }

  return { ok: true };
}
