import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from './envelope.js';

/**
 * instances.ts (P08 Unit U6c) - contracts for the six instance link/park
 * routes (`instances.routes.ts`). `POST /v1/instances` replaces the P04b
 * 501-stub contract-less route; the other five are new for P08. Deliberately
 * NOT wired into `appContract` yet the way `onboardingContract` is - see
 * `router.ts`'s own comment on why the stub stayed unadvertised; this
 * contract module wires in as `instancesContract` once the stub note is
 * superseded (this unit does that wiring - see router.ts below).
 *
 * The masked-phone shape (`maskedNumber`) is the ONLY phone-number-shaped
 * field any of these contracts ever emit - the full E.164 number never
 * leaves the API (canon). `@wp/domain`'s `maskPhoneE164` output shape is
 * `+<cc>·····<last2>`.
 */

const MASKED_NUMBER_PATTERN = /^\+\d{1,3}·····\d{2}$/u;
const maskedNumberSchema = z.string().regex(MASKED_NUMBER_PATTERN).nullable();

export const linkStateSchema = z.enum(['unlinked', 'pairing', 'linked']);
export type LinkStateContract = z.infer<typeof linkStateSchema>;

export const healthStateSchema = z.enum([
  'never_linked',
  'connected',
  'degraded',
  'paused',
  'logged_out',
]);
export type HealthStateContract = z.infer<typeof healthStateSchema>;

export const desiredStateSchema = z.enum(['online', 'offline']);
export type DesiredStateContract = z.infer<typeof desiredStateSchema>;

// ---------------------------------------------------------------------
// POST /v1/instances
// ---------------------------------------------------------------------

export const createInstanceInputSchema = z.object({
  label: z.string().trim().min(1).max(64),
});

export const createInstanceOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    label: z.string(),
    linkState: linkStateSchema,
    healthState: healthStateSchema,
    desiredState: desiredStateSchema,
  }),
);

export const createInstanceContract = oc
  .route({ method: 'POST', path: '/v1/instances' })
  .input(createInstanceInputSchema)
  .output(createInstanceOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/instances/:id/link
// ---------------------------------------------------------------------

export const linkInstanceInputSchema = z.object({
  method: z.enum(['qr', 'code']),
  phone: z.string().trim().min(1).max(32).optional(),
});

export const linkInstanceOutputSchema = successEnvelope(
  z.object({
    linkState: z.literal('pairing'),
  }),
);

export const linkInstanceContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/link' })
  .input(linkInstanceInputSchema)
  .output(linkInstanceOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/instances/:id/link/refresh
// ---------------------------------------------------------------------

export const refreshLinkOutputSchema = successEnvelope(
  z.object({
    challenge: z.null(),
    linkState: z.literal('pairing'),
  }),
);

export const refreshLinkContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/link/refresh' })
  .output(refreshLinkOutputSchema);

// ---------------------------------------------------------------------
// GET /v1/instances/:id/link-status
// ---------------------------------------------------------------------

export const linkStatusOutputSchema = successEnvelope(
  z.object({
    linkState: linkStateSchema,
    healthState: healthStateSchema,
    desiredState: desiredStateSchema,
    needsUserAction: z.boolean(),
    userActionReason: z.string().nullable(),
    attemptsLeft: z.number().int().min(0),
    maskedNumber: maskedNumberSchema,
  }),
);

export const linkStatusContract = oc
  .route({ method: 'GET', path: '/v1/instances/{id}/link-status' })
  .output(linkStatusOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/instances/:id/online
// ---------------------------------------------------------------------

export const onlineHolderSchema = z.object({
  instanceId: z.uuid(),
  label: z.string().nullable(),
  maskedNumber: maskedNumberSchema,
});

export const onlineInstanceOutputSchema = successEnvelope(
  z.object({
    desiredState: z.literal('online'),
  }),
);

export const noFreeSlotDetailsSchema = z.object({
  holders: z.array(onlineHolderSchema),
});

export const onlineInstanceContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/online' })
  .output(onlineInstanceOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/instances/:id/park
// ---------------------------------------------------------------------

export const parkInstanceOutputSchema = successEnvelope(
  z.object({
    desiredState: z.literal('offline'),
    parkedCopy: z.string(),
  }),
);

export const parkInstanceContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/park' })
  .output(parkInstanceOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/instances/:id/resume (P16 Unit D, step 8) - human-only resume.
// `.strict()`: no `origin`-like field, matching every other tenant-input
// schema in this file. `acknowledgement` must be exactly `true` (never a
// truthy string/number) when the pause was a provider-restriction signal -
// enforced by the service, not this schema (the schema only shapes the
// wire type; 422 ACKNOWLEDGEMENT_REQUIRED is a business rule).
// ---------------------------------------------------------------------

export const resumeInstanceInputSchema = z
  .object({
    acknowledgement: z.boolean().optional(),
    reason: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const resumeInstanceOutputSchema = successEnvelope(
  z.object({
    healthState: healthStateSchema,
  }),
);

export const resumeInstanceContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/resume' })
  .input(resumeInstanceInputSchema)
  .output(resumeInstanceOutputSchema);

export const instancesContract = {
  create: createInstanceContract,
  link: linkInstanceContract,
  linkRefresh: refreshLinkContract,
  linkStatus: linkStatusContract,
  online: onlineInstanceContract,
  park: parkInstanceContract,
  resume: resumeInstanceContract,
} as const;
