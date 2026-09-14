import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from './envelope.js';
import { passwordSchema } from './auth.js';

/**
 * auth-password.ts (P28 Unit U2, step 3) - the password change/forgot/reset
 * flow plus the impersonation-session refresh, split out of `auth.ts`
 * (which was already at 256/300 lines - same "sibling module, never trim a
 * contract comment to make room" idiom as `contacts-exports.ts`). Re-
 * exported from `src/index.ts` via the same `export *` trick as the other
 * 300-line-cap splits.
 *
 * `forgotPasswordContract`'s `{ accepted: true }` response NEVER reveals
 * whether `email` exists - same existence-oracle discipline as
 * `loginResultSchema`'s shared `UNAUTHENTICATED` code (`auth.ts`'s own
 * comment on `authenticatedResultSchema`).
 */

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export const changePasswordOutputSchema = successEnvelope(
  z.object({
    changed: z.literal(true),
    otherSessionsRevoked: z.number().int(),
  }),
);
export type ChangePasswordOutput = z.infer<typeof changePasswordOutputSchema>;

export const changePasswordContract = oc
  .route({ method: 'POST', path: '/v1/auth/password/change' })
  .input(changePasswordInputSchema)
  .output(changePasswordOutputSchema);

export const forgotPasswordInputSchema = z.object({
  email: z.string().email().max(254),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;

export const forgotPasswordOutputSchema = successEnvelope(
  z.object({
    accepted: z.literal(true),
  }),
);
export type ForgotPasswordOutput = z.infer<typeof forgotPasswordOutputSchema>;

export const forgotPasswordContract = oc
  .route({ method: 'POST', path: '/v1/auth/password/forgot' })
  .input(forgotPasswordInputSchema)
  .output(forgotPasswordOutputSchema);

export const resetPasswordInputSchema = z.object({
  token: z.string().min(20).max(400),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

export const resetPasswordOutputSchema = successEnvelope(
  z.object({
    reset: z.literal(true),
  }),
);
export type ResetPasswordOutput = z.infer<typeof resetPasswordOutputSchema>;

export const resetPasswordContract = oc
  .route({ method: 'POST', path: '/v1/auth/password/reset' })
  .input(resetPasswordInputSchema)
  .output(resetPasswordOutputSchema);

export const impersonationRefreshOutputSchema = successEnvelope(
  z.object({
    accessToken: z.string(),
    expiresAt: z.string().datetime(),
  }),
);
export type ImpersonationRefreshOutput = z.infer<typeof impersonationRefreshOutputSchema>;

export const impersonationRefreshContract = oc
  .route({ method: 'POST', path: '/v1/auth/impersonation/refresh' })
  .output(impersonationRefreshOutputSchema);

export const authPasswordContract = {
  changePassword: changePasswordContract,
  forgotPassword: forgotPasswordContract,
  resetPassword: resetPasswordContract,
  impersonationRefresh: impersonationRefreshContract,
} as const;
