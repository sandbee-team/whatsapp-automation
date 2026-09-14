import { matchOptOutKeyword, resolveOptOutKeywords } from '@wp/domain';
import type { TenantQueryable } from '@wp/db';
import { logger, type MetricsRegistry } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  cancelOptOutJobs,
  recordOptOut,
  sealPhoneForOptOut,
  type OptOutMirrorPort,
} from '../pacing/index.js';
import { bindInboundMetrics } from './metrics.js';

/**
 * optout-detect.ts (P14 Unit U3, step 6; FINDING 7 FIX, P14 review-fix F2) -
 * `detectInboundOptOut`, the hook the P21 inbound handler will call for
 * every inbound text message. Matches against
 * `resolveOptOutKeywords(tenantKeywords)` (platform floor + tenant
 * additions, `@wp/domain`) via `matchOptOutKeyword`.
 *
 * Attribution rule (core invariant 6 extended - never widen an opt-out to a
 * recipient who didn't ask for it): a match is only recorded when
 * `senderE164` is present. A `@lid`-only group sender with no resolvable
 * lid<->pn mapping writes NOTHING to `opt_outs` - never guesses a contact -
 * and is counted instead (`wp_optout_unattributable_total`), logged at warn
 * with ids only (no JID content, no message text, no phone number - PII
 * discipline).
 *
 * FINDING 7 (P14 review-fix F2, P14 C1 review): the P21 handler contract is
 * that a confirmation send must never outlive a ROLLED-BACK opt-out. This
 * module previously invoked `deps.onOptedOut` synchronously INSIDE the
 * caller's still-open transaction - if that transaction later rolled back
 * for an unrelated reason, the confirmation had already fired (or been
 * scheduled to fire) for an opt-out that never actually committed. The port
 * is removed from this module's own contract entirely: `detectInboundOptOut`
 * now returns an `optedOut` descriptor on a successful attributed match, and
 * the CALLER invokes the confirmation sender ONLY AFTER its own transaction
 * has committed - the same idiom `messages.service.ts`'s `onEnqueued` uses
 * (`system-send.ts#bindOptOutConfirmationSender` is unchanged: it is still
 * the post-commit binding, just invoked at the call site now instead of
 * in-tx here).
 *
 * `deps.mirror` (P20 Unit U8, step 8) - the SAME `OptOutMirrorPort`
 * `modules/pacing`'s `recordOptOut` requires - is threaded straight through
 * to that call. This module deliberately does NOT import `modules/contacts`
 * itself (keeps the inbound/session-worker import graph light); the P21
 * inbound handler is what wires the real `syncOptOutMirror` in when it
 * builds this deps object.
 */

export interface DetectInboundOptOutDeps {
  tx: TenantQueryable;
  provider: KeyProvider;
  mirror: OptOutMirrorPort;
  encVersion?: number;
  metricsRegistry?: MetricsRegistry;
}

export interface DetectInboundOptOutInput {
  clientId: string;
  instanceId: string;
  senderJid: string;
  senderE164: string | null;
  text: string;
  tenantKeywords: readonly string[];
}

export interface DetectInboundOptOutResult {
  matched: string | null;
  attributed: boolean;
  /** Present only on a successful attributed opt-out (matched + recorded + queued jobs cancelled, all inside the caller's own transaction). The caller MUST invoke its confirmation sender with this payload only AFTER that transaction has committed - never from inside it (see this module's own "FINDING 7" doc). */
  optedOut?: {
    clientId: string;
    instanceId: string;
    phoneHash: Buffer;
    e164: string;
  };
}

const DEFAULT_ENC_VERSION = 1;

export async function detectInboundOptOut(
  deps: DetectInboundOptOutDeps,
  input: DetectInboundOptOutInput,
): Promise<DetectInboundOptOutResult> {
  const keywords = resolveOptOutKeywords(input.tenantKeywords);
  const matched = matchOptOutKeyword(input.text, keywords);

  if (matched === null) {
    return { matched: null, attributed: false };
  }

  if (input.senderE164 === null) {
    const { optOutUnattributableTotal } = bindInboundMetrics(deps.metricsRegistry);
    optOutUnattributableTotal.inc();
    logger.warn(
      { client_id: input.clientId, instance_id: input.instanceId },
      'optout-detect: matched opt-out keyword from an unattributable (@lid-only) sender - not recorded, not misattributed',
    );
    return { matched, attributed: false };
  }

  const phoneHash = hashRecipient(deps.provider, input.senderE164);
  const phoneEnc = sealPhoneForOptOut(deps.provider, {
    clientId: input.clientId,
    e164OrJid: input.senderE164,
    recordId: phoneHash.toString('hex'),
    encVersion: deps.encVersion ?? DEFAULT_ENC_VERSION,
  });

  await recordOptOut(
    deps.tx,
    {
      clientId: input.clientId,
      scope: 'client',
      scopeKey: input.clientId,
      phoneHash,
      phoneEnc,
      source: 'inbound_keyword',
      matchedKeyword: matched,
      originInstanceId: input.instanceId,
    },
    { mirror: deps.mirror },
  );

  await cancelOptOutJobs(deps.tx, { clientId: input.clientId, phoneHash, scope: 'client' });

  return {
    matched,
    attributed: true,
    optedOut: {
      clientId: input.clientId,
      instanceId: input.instanceId,
      phoneHash,
      e164: input.senderE164,
    },
  };
}
