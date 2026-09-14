import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  BROADCAST_DISCLOSURE,
  BROADCAST_ESTIMATE_CAVEAT,
  BROADCAST_FREQUENCY_NOTE,
  GROUP_RISK_DISCLOSURE,
} from '@wp/domain';
import { successEnvelope } from '../envelope.js';
import { getBroadcastInputSchema } from './broadcasts.js';

/**
 * app/broadcasts-preflight.ts (P23a step 2) - the pre-flight quote for a
 * `draft`/`scheduled` broadcast, `POST /v1/broadcasts/{id}/preflight`. Sibling
 * of `broadcasts.ts` (that file sits near the `max-lines` cap). The shape is
 * the scope delta's pre-flight block, line by line:
 *
 *   Audience          matched · skipped (per reason)
 *   Already messaged  client-level deferrals from `recipient_send_buckets`
 *                     (excluded from the estimate) + the verbatim per-workspace
 *                     frequency line
 *   Billable          count × rate (integer PAISE, never a float)
 *   Wallet            balance → after this broadcast
 *   Account           instance · warm-up tier · effective daily cap · sent today
 *   Estimated finish  cap-derived, labelled an estimate, with exactly TWO
 *                     levers: reduce the audience, wait for warm-up. There is
 *                     no faster mode, so the schema cannot express one.
 *
 * Every copy string that must ship verbatim is a `z.literal` of its `@wp/domain`
 * source so a drifted copy fails validation instead of silently shipping.
 * `.strict()` everywhere - an unplanned field cannot widen the wire shape.
 */

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

/** The ONLY levers the pre-flight may offer - never a "faster"/"boost" option (it does not exist). */
export const BROADCAST_PREFLIGHT_OPTIONS = ['reduce_audience', 'wait_for_warm_up'] as const;
export const broadcastPreflightOptionSchema = z.enum(BROADCAST_PREFLIGHT_OPTIONS);
export type BroadcastPreflightOption = z.infer<typeof broadcastPreflightOptionSchema>;

/** One skip reason bucket - `reason` carries the SAME label the snapshot writes to `campaign_recipients.skip_reason` (`opted_out`, `missing_var:<token>`). */
export const broadcastPreflightSkipReasonSchema = z
  .object({
    reason: z.string().min(1),
    count: nonNegativeInt,
  })
  .strict();
export type BroadcastPreflightSkipReason = z.infer<typeof broadcastPreflightSkipReasonSchema>;

export const broadcastPreflightSchema = z
  .object({
    broadcastId: z.string().uuid(),
    audience: z
      .object({
        /** Distinct live contacts the audience JSON matches - `snapshot-audience-count.sql` semantics. */
        matched: nonNegativeInt,
        skipped: nonNegativeInt,
        skipReasons: z.array(broadcastPreflightSkipReasonSchema),
        /** `matched - skipped`. */
        sendable: nonNegativeInt,
      })
      .strict(),
    alreadyMessaged: z
      .object({
        /** CLIENT-level: sendable contacts whose `recipient_send_buckets` already sit at/over `perRecipient24h` or `perRecipient7d` for this workspace - they wait for the window, excluded from `billable`. */
        deferred: nonNegativeInt,
        perRecipient24h: positiveInt,
        perRecipient7d: positiveInt,
        note: z.literal(BROADCAST_FREQUENCY_NOTE),
      })
      .strict(),
    billable: z
      .object({
        /** `sendable - deferred`. */
        count: nonNegativeInt,
        priceKey: z.string().min(1),
        /** Integer paise - the client's RESOLVED rate (`client_pricing` override, else the price list). */
        rateMinor: nonNegativeInt,
        /** `count * rateMinor`, integer paise - stamped onto `campaigns.quote_minor`. */
        quoteMinor: nonNegativeInt,
      })
      .strict(),
    wallet: z
      .object({
        balanceMinor: z.number().int(),
        /** `balanceMinor - quoteMinor` - may be negative; sending pauses when the wallet empties, queued messages are kept. */
        afterMinor: z.number().int(),
        sufficient: z.boolean(),
      })
      .strict(),
    account: z
      .object({
        instanceId: z.string().uuid(),
        label: z.string(),
        warmupTier: positiveInt,
        effDailyCap: nonNegativeInt,
        sentToday: nonNegativeInt,
        /** `max(effDailyCap - sentToday, 0)`. */
        remainingToday: nonNegativeInt,
      })
      .strict(),
    estimate: z
      .object({
        /** Calendar days INCLUDING today; `0` when nothing is billable; `null` when `effDailyCap` is 0 (no estimate is possible). */
        totalDays: nonNegativeInt.nullable(),
        /** ISO-8601; `null` exactly when `totalDays` is `null`. */
        finishAt: z.string().nullable(),
        caveat: z.literal(BROADCAST_ESTIMATE_CAVEAT),
        options: z.array(broadcastPreflightOptionSchema),
      })
      .strict(),
    fanOut: z
      .object({
        /** The instance's EFFECTIVE pacing-profile thresholds (`pacing_profiles.dup_fanout_warn/ack`) - never a hard-coded 150/500. */
        warnThreshold: positiveInt,
        ackThreshold: positiveInt,
        /** `billable.count > ackThreshold` - jobs queue behind the P14 `NEEDS_HUMAN_ACK` banner until a human acks (the `ack-fanout` route). */
        requiresHumanAck: z.boolean(),
      })
      .strict(),
    disclosure: z.literal(BROADCAST_DISCLOSURE),
    /**
     * P24 groups-messaging Unit U2: present only when `audience.kind` is
     * `'groups'`. `reachIsApproximate` is always `true` literally - group
     * reach is never an exact figure (`DEVICES_PER_PARTICIPANT_ESTIMATE` is
     * itself a derived, unmeasured ratio - see `@wp/domain`'s own doc
     * comment on that constant).
     */
    groups: z
      .object({
        groupsMatched: nonNegativeInt,
        groupsSkipped: nonNegativeInt,
        skipReasons: z.array(broadcastPreflightSkipReasonSchema),
        reachEstimate: nonNegativeInt,
        reachIsApproximate: z.literal(true),
        effGroupDailyCap: nonNegativeInt,
        groupSentToday: nonNegativeInt,
        groupRemainingToday: nonNegativeInt,
        capIsZeroAtTier: z.boolean(),
        riskDisclosure: z.literal(GROUP_RISK_DISCLOSURE),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BroadcastPreflight = z.infer<typeof broadcastPreflightSchema>;

export const preflightBroadcastInputSchema = getBroadcastInputSchema;
export type PreflightBroadcastInput = z.infer<typeof preflightBroadcastInputSchema>;

export const preflightBroadcastOutputSchema = successEnvelope(broadcastPreflightSchema);
export type PreflightBroadcastOutput = z.infer<typeof preflightBroadcastOutputSchema>;

export const preflightBroadcastContract = oc
  .route({ method: 'POST', path: '/v1/broadcasts/{id}/preflight' })
  .input(preflightBroadcastInputSchema)
  .output(preflightBroadcastOutputSchema);
