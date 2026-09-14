import { oc } from '@orpc/contract';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { IMPERSONATION_SCOPES } from '@wp/domain';
import { successEnvelope } from './envelope.js';
import { onboardingStepSchema } from './onboarding.js';

/**
 * Auth field schemas - validate-and-replace: the handler only ever sees the
 * parsed (canonical) output, never the raw typed input.
 */
export const fullNameSchema = z.string().trim().min(1).max(200);

export const companyNameSchema = z.string().trim().min(1).max(200);

/** Trimmed, lowercased (citext-safe canonical form), valid email, max 320. */
export const emailSchema = z.string().trim().max(320).toLowerCase().pipe(z.email());

/**
 * REQUIRED at signup. Parsed with `defaultCountry: 'IN'` and replaced with
 * the canonical E.164 `.number` - the as-typed value is never stored or
 * emitted.
 */
export const phoneE164Schema = z.string().transform((value, ctx) => {
  const parsed = parsePhoneNumberFromString(value, 'IN');
  if (!parsed || !parsed.isValid()) {
    ctx.addIssue({ code: 'custom', message: 'Must be a valid phone number' });
    return z.NEVER;
  }
  return parsed.number;
});

/**
 * Length only - no composition rules (argon2id hashing happens server-side).
 * Leading/trailing whitespace is rejected as a likely paste/typo artifact.
 */
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => value === value.trim(), {
    message: 'Must not start or end with whitespace',
  });

export const signupInputSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  phoneE164: phoneE164Schema,
  companyName: companyNameSchema,
  password: passwordSchema,
});

export const signupOutputSchema = successEnvelope(
  z.object({
    userId: z.uuid(),
    clientId: z.uuid(),
    onboardingStep: onboardingStepSchema,
  }),
);

export const signupContract = oc
  .route({ method: 'POST', path: '/v1/auth/signup' })
  .input(signupInputSchema)
  .output(signupOutputSchema);

export const verifyEmailInputSchema = z.object({
  token: z.string().min(32).max(128),
});

export const verifyEmailOutputSchema = successEnvelope(
  z.object({
    ok: z.literal(true),
    onboardingStep: onboardingStepSchema,
  }),
);

export const verifyEmailContract = oc
  .route({ method: 'POST', path: '/v1/auth/verify-email' })
  .input(verifyEmailInputSchema)
  .output(verifyEmailOutputSchema);

/**
 * M18 (P04a FIXB): login's password is NOT the signup 12-char policy - a
 * short/legacy password must reach `login()`'s dummy-verify path (timing-safe
 * unknown-email/wrong-password parity), never 400 before it. Length-bounded
 * only (`max(128)` matches argon2's own practical input ceiling).
 */
export const loginPasswordSchema = z.string().min(1).max(128);

export const loginInputSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});

/**
 * Unknown-email and wrong-password login share ONE runtime error code
 * (`UNAUTHENTICATED`) and this ONE success shape at the contract level -
 * carried reviewer N17: distinguishing them anywhere is a cross-tenant/
 * cross-account existence oracle.
 */
export const authenticatedResultSchema = z.object({
  kind: z.literal('authenticated'),
  accessToken: z.string(),
  user: z.object({
    id: z.uuid(),
    email: emailSchema,
    fullName: fullNameSchema,
  }),
});

export const mfaRequiredResultSchema = z.object({
  kind: z.literal('mfa_required'),
  mfaToken: z.string(),
});

export const loginResultSchema = z.discriminatedUnion('kind', [
  authenticatedResultSchema,
  mfaRequiredResultSchema,
]);

export const loginOutputSchema = successEnvelope(loginResultSchema);

export const loginContract = oc
  .route({ method: 'POST', path: '/v1/auth/login' })
  .input(loginInputSchema)
  .output(loginOutputSchema);

export const totpVerifyInputSchema = z.object({
  mfaToken: z.string(),
  code: z.string().regex(/^\d{6}$/),
});

export const totpVerifyOutputSchema = successEnvelope(authenticatedResultSchema);

export const totpVerifyContract = oc
  .route({ method: 'POST', path: '/v1/auth/totp/verify' })
  .input(totpVerifyInputSchema)
  .output(totpVerifyOutputSchema);

/**
 * P04b Unit UB1a, task 2: the recovery-code login continuation - same shape
 * class as `/totp/verify` (a public route gated by a short-lived `mfaToken`,
 * never a bare session). `recoveryCode` bounds mirror how codes are issued
 * (totp-secret.ts's `RECOVERY_CODE_LENGTH = 10`, Crockford-base32
 * alphabet) - trimmed, length-bounded only (no character-set check here;
 * the storage-layer hash comparison is the real gate, and a slightly wider
 * bound costs nothing while staying forward-compatible with a future code
 * length change).
 */
export const totpRecoveryInputSchema = z.object({
  mfaToken: z.string(),
  recoveryCode: z.string().trim().min(6).max(32),
});

export const totpRecoveryOutputSchema = successEnvelope(authenticatedResultSchema);

export const totpRecoveryContract = oc
  .route({ method: 'POST', path: '/v1/auth/totp/recovery' })
  .input(totpRecoveryInputSchema)
  .output(totpRecoveryOutputSchema);

export const totpEnrolOutputSchema = successEnvelope(
  z.object({
    otpauthUrl: z.string(),
    secretShownOnce: z.string(),
  }),
);

export const totpEnrolContract = oc
  .route({ method: 'POST', path: '/v1/auth/totp/enrol' })
  .output(totpEnrolOutputSchema);

export const totpEnrolConfirmInputSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

export const totpEnrolConfirmOutputSchema = successEnvelope(
  z.object({
    recoveryCodes: z.array(z.string()),
  }),
);

export const totpEnrolConfirmContract = oc
  .route({ method: 'POST', path: '/v1/auth/totp/enrol/confirm' })
  .input(totpEnrolConfirmInputSchema)
  .output(totpEnrolConfirmOutputSchema);

export const refreshOutputSchema = successEnvelope(
  z.object({
    accessToken: z.string(),
  }),
);

export const refreshContract = oc
  .route({ method: 'POST', path: '/v1/auth/refresh' })
  .output(refreshOutputSchema);

export const logoutOutputSchema = successEnvelope(
  z.object({
    ok: z.literal(true),
  }),
);

export const logoutContract = oc
  .route({ method: 'POST', path: '/v1/auth/logout' })
  .output(logoutOutputSchema);

/**
 * `impersonation` is present only while the session is a staff-minted
 * impersonation token (P28 Unit U2, step 3) - every other field above is
 * unchanged from its P04 shape.
 */
export const meOutputSchema = successEnvelope(
  z.object({
    user: z.object({
      id: z.uuid(),
      email: emailSchema,
      fullName: fullNameSchema,
      emailVerifiedAt: z.string().nullable(),
      mfaEnabledAt: z.string().nullable(),
    }),
    client: z.object({
      id: z.uuid(),
      companyName: companyNameSchema,
      onboardingStep: onboardingStepSchema,
      status: z.string(),
    }),
    membership: z.object({
      role: z.string(),
    }),
    impersonation: z
      .object({
        grantId: z.string(),
        scope: z.enum(IMPERSONATION_SCOPES),
        expiresAt: z.string().datetime(),
        staffLabel: z.string(),
      })
      .strict()
      .optional(),
  }),
);

export const meContract = oc.route({ method: 'GET', path: '/v1/auth/me' }).output(meOutputSchema);

export const authContract = {
  signup: signupContract,
  verifyEmail: verifyEmailContract,
  login: loginContract,
  totpVerify: totpVerifyContract,
  totpRecovery: totpRecoveryContract,
  totpEnrol: totpEnrolContract,
  totpEnrolConfirm: totpEnrolConfirmContract,
  refresh: refreshContract,
  logout: logoutContract,
  me: meContract,
} as const;
