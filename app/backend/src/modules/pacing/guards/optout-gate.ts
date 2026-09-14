import type { TenantQueryable } from '@wp/db';
import type { GuardDecision, SendOrigin } from '@wp/domain';
import { isOptedOut } from '../optout/registry.js';

/**
 * optout-gate.ts (P14 Unit U4, step 3) - `evaluateOptOutGate`, the guard the
 * claim pipeline's pacing/content evaluation runs to decide whether a
 * QUEUED job may proceed to dispatch. `GuardDecision`/`OPT_OUT`
 * (`@wp/domain`) are the SAME shapes `engine/pacing/index.ts#reserve()`'s
 * own denial resolves to - this guard is a second, independent check over
 * the SAME `OPT_OUT` reason, not a competing authority: `isOptedOut`
 * (`modules/pacing/optout/registry.ts`) is the single lookup this and every
 * other opt-out check point (enqueue-time in `messages.service.ts`,
 * pre-send in `engine/queue/dispatch.ts`) all call.
 *
 * Three ways a job passes this gate untouched:
 *   - `isGroup` - a group is structurally excluded from the opt-out gate
 *     (`registry.ts`'s own "excluded by recipient_jid shape" contract; a
 *     group's `recipient_hash` may coincidentally collide with a contact's
 *     hash, which is exactly why the exclusion is by shape, never by hash
 *     equality).
 *   - `recipientHash === null` - a pre-P14 row (migration 0007's column
 *     existed before this phase populated it) has nothing to look up; never
 *     block on an absent hash.
 *   - `sendOrigin === 'opt_out_confirmation'` - the ONE origin this gate
 *     lets through even for an opted-out contact (the confirmation message
 *     itself must reach the very person who just opted out). Every OTHER
 *     origin, including the pacing-exempt `'system_reply'`, is still
 *     subject to this gate (mandatory test 16 amendment, phase file
 *     verbatim: "'system_reply' is exempt from pacing but NOT from the
 *     opt-out gate") - pacing exemption and opt-out exemption are two
 *     independent axes, never conflated here.
 */

export interface EvaluateOptOutGateInput {
  clientId: string;
  instanceId: string;
  recipientHash: Buffer | null;
  isGroup: boolean;
  sendOrigin: SendOrigin;
}

export async function evaluateOptOutGate(
  tx: TenantQueryable,
  input: EvaluateOptOutGateInput,
): Promise<GuardDecision> {
  if (
    input.isGroup ||
    input.recipientHash === null ||
    input.sendOrigin === 'opt_out_confirmation'
  ) {
    return { ok: true };
  }

  const optedOut = await isOptedOut(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    phoneHash: input.recipientHash,
  });

  if (!optedOut) {
    return { ok: true };
  }

  return { ok: false, reason: 'OPT_OUT', retryAt: null };
}
