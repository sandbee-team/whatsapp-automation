import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from './envelope.js';

/**
 * The founder onboarding step machine. Labels MUST match the DB enum
 * (`onboarding_step`) exactly, including order - see
 * `.memory/research/2026-08-25-v1-architecture-blueprint.md`. Contracts only
 * here; the onboarding service (state transitions, persistence) is a later
 * session.
 */
export const onboardingStepSchema = z.enum([
  'verify_email',
  'choose_timezone',
  'accept_pacing_profile',
  'attest_consent',
  'connect_whatsapp',
  'send_test',
  'done',
]);

export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/**
 * Browser-pure IANA timezone validation: `Intl.DateTimeFormat` throws a
 * `RangeError` for any zone name it does not recognise (fixed offsets like
 * `UTC+5` included), so a successful construction is proof of a valid IANA
 * zone without a hand-maintained zone list.
 */
export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA timezone name' },
);

export const onboardingStatusOutputSchema = successEnvelope(
  z.object({
    step: onboardingStepSchema,
    timezone: z.string().nullable(),
    pacingProfileKey: z.string().nullable(),
    consentAttestedAt: z.string().nullable(),
    consentTosVersion: z.string().nullable(),
  }),
);

export const getOnboardingContract = oc
  .route({ method: 'GET', path: '/v1/onboarding' })
  .output(onboardingStatusOutputSchema);

export const setTimezoneInputSchema = z.object({
  timezone: timezoneSchema,
});

export const setTimezoneOutputSchema = successEnvelope(
  z.object({
    step: onboardingStepSchema,
  }),
);

export const setTimezoneContract = oc
  .route({ method: 'POST', path: '/v1/onboarding/timezone' })
  .input(setTimezoneInputSchema)
  .output(setTimezoneOutputSchema);

/**
 * `profileKey` is a machine identifier here on purpose: the allowed set of
 * pacing profiles is server-owned (P13) and is deliberately NOT enumerated
 * in this browser-shared contract - only its SHAPE is validated. Restricted
 * to lowercase ascii letters/digits/underscore/hyphen, 1-64 chars (P04b
 * FIXF, C1 MAJOR-1): a free-form string let control characters (e.g. a raw
 * NUL byte) survive JSON and reach Postgres as an invalid byte sequence
 * (22021), a raw 500 instead of a 400 at the API boundary. The wizard's own
 * value, `'safe_default'`, matches this pattern.
 */
export const setPacingProfileInputSchema = z.object({
  profileKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,64}$/),
});

export const setPacingProfileOutputSchema = successEnvelope(
  z.object({
    step: onboardingStepSchema,
  }),
);

export const setPacingProfileContract = oc
  .route({ method: 'POST', path: '/v1/onboarding/pacing-profile' })
  .input(setPacingProfileInputSchema)
  .output(setPacingProfileOutputSchema);

export const setConsentInputSchema = z.object({
  accepted: z.literal(true),
});

export const setConsentOutputSchema = successEnvelope(
  z.object({
    step: onboardingStepSchema,
  }),
);

export const setConsentContract = oc
  .route({ method: 'POST', path: '/v1/onboarding/consent' })
  .input(setConsentInputSchema)
  .output(setConsentOutputSchema);

export const onboardingContract = {
  get: getOnboardingContract,
  setTimezone: setTimezoneContract,
  setPacingProfile: setPacingProfileContract,
  setConsent: setConsentContract,
} as const;
