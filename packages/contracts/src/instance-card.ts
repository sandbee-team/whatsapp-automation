import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  WA_LINK_STATES,
  WA_HEALTHS,
  INSTANCE_DESIRED_STATES,
  HEALTH_SIGNAL_NAMES,
} from '@wp/domain';
import { successEnvelope } from './envelope.js';

/**
 * instance-card.ts (P17 Unit U2, step 2) - contracts for
 * `GET /v1/instances/:id/card` (the panel's per-instance summary card) and
 * `GET /v1/instances/:id/health/why` (the why-drawer's twelve-signal
 * breakdown). Follows `instances.ts`'s idiom.
 *
 * `serverNow` on the card lets the panel compute clock skew locally rather
 * than trusting its own clock for the countdown-floor math
 * (`INSTANCE_CARD_COPY.notSending`, `@wp/domain`) - never an ETA promise.
 *
 * `healthBand` is a plain string here (not yet a registered `@wp/domain`
 * enum as of this unit) - `'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL'`
 * mirrors the band literals already used in `HEALTH_BAND_EFFECTS`
 * (`@wp/domain`'s `pacing/warmup-ladder.ts`).
 */

const healthBandSchema = z.enum(['HEALTHY', 'WATCH', 'DEGRADED', 'CRITICAL']);

const sendingWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  tz: z.string(),
});

// ---------------------------------------------------------------------
// GET /v1/instances/:id/card
// ---------------------------------------------------------------------

export const instanceCardDataSchema = z.object({
  instanceId: z.uuid(),
  label: z.string(),
  linkState: z.enum(WA_LINK_STATES),
  healthState: z.enum(WA_HEALTHS),
  desiredState: z.enum(INSTANCE_DESIRED_STATES),
  parked: z.boolean(),
  needsUserAction: z.boolean(),
  userActionReason: z.string().nullable(),
  healthScore: z.number().min(0).max(100).nullable(),
  healthBand: healthBandSchema,
  warmupTier: z.number().int().nonnegative(),
  warmupDay: z.number().int().nonnegative(),
  todaySent: z.number().int().nonnegative(),
  effDailyCap: z.number().int().nonnegative(),
  newConversationsToday: z.number().int().nonnegative(),
  effNewConvCap: z.number().int().nonnegative(),
  sendingWindow: sendingWindowSchema,
  lastSendAt: z.iso.datetime().nullable(),
  queueDepth: z.number().int().nonnegative(),
  queueDepthCapped: z.boolean(),
  oldestQueuedAgeSeconds: z.number().nonnegative().nullable(),
  nextSendEarliestAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
});
export type InstanceCardData = z.infer<typeof instanceCardDataSchema>;

export const instanceCardOutputSchema = successEnvelope(instanceCardDataSchema);
export type InstanceCardOutput = z.infer<typeof instanceCardOutputSchema>;

export const instanceCardContract = oc
  .route({ method: 'GET', path: '/v1/instances/{id}/card' })
  .output(instanceCardOutputSchema);

// ---------------------------------------------------------------------
// GET /v1/instances/:id/health/why
// ---------------------------------------------------------------------

/** Exactly twelve entries - one per `HEALTH_SIGNAL_NAMES` member, in that order. */
const EXACT_SIGNAL_COUNT = HEALTH_SIGNAL_NAMES.length;

export const healthSignalEntrySchema = z.object({
  signal: z.enum(HEALTH_SIGNAL_NAMES),
  measuredValue: z.number().nullable(),
  window: z.string(),
  evidenceCount: z.number().int().nonnegative(),
  scored: z.boolean(),
  pointsCost: z.number().nonnegative(),
  exemptReason: z.string().nullable(),
});
export type HealthSignalEntry = z.infer<typeof healthSignalEntrySchema>;

export const healthTimelineEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  createdAt: z.iso.datetime(),
});

export const healthWhyDataSchema = z.object({
  signals: z.array(healthSignalEntrySchema).length(EXACT_SIGNAL_COUNT),
  timeline: z.array(healthTimelineEntrySchema),
});
export type HealthWhyData = z.infer<typeof healthWhyDataSchema>;

export const healthWhyOutputSchema = successEnvelope(healthWhyDataSchema);
export type HealthWhyOutput = z.infer<typeof healthWhyOutputSchema>;

export const healthWhyContract = oc
  .route({ method: 'GET', path: '/v1/instances/{id}/health/why' })
  .output(healthWhyOutputSchema);

export const instanceCardContractGroup = {
  card: instanceCardContract,
  healthWhy: healthWhyContract,
} as const;
