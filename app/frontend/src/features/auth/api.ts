import type { z } from 'zod';
import {
  changePasswordInputSchema,
  changePasswordOutputSchema,
  forgotPasswordInputSchema,
  forgotPasswordOutputSchema,
  loginInputSchema,
  loginOutputSchema,
  meOutputSchema,
  resetPasswordInputSchema,
  resetPasswordOutputSchema,
  signupInputSchema,
  signupOutputSchema,
  totpEnrolConfirmInputSchema,
  totpEnrolConfirmOutputSchema,
  totpEnrolOutputSchema,
  totpRecoveryInputSchema,
  totpRecoveryOutputSchema,
  totpVerifyInputSchema,
  totpVerifyOutputSchema,
  verifyEmailInputSchema,
  verifyEmailOutputSchema,
} from '@wp/contracts';
import { apiFetch, setAccessToken } from '../../lib/api-client.js';
import { queryClient } from '../../providers/query-client.js';

export type SignupInput = z.infer<typeof signupInputSchema>;
export type SignupOutput = z.infer<typeof signupOutputSchema>['data'];

export type VerifyEmailInput = z.infer<typeof verifyEmailInputSchema>;
export type VerifyEmailOutput = z.infer<typeof verifyEmailOutputSchema>['data'];

export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginOutput = z.infer<typeof loginOutputSchema>['data'];

export type TotpVerifyInput = z.infer<typeof totpVerifyInputSchema>;
export type TotpVerifyOutput = z.infer<typeof totpVerifyOutputSchema>['data'];

export type TotpEnrolOutput = z.infer<typeof totpEnrolOutputSchema>['data'];

export type TotpEnrolConfirmInput = z.infer<typeof totpEnrolConfirmInputSchema>;
export type TotpEnrolConfirmOutput = z.infer<typeof totpEnrolConfirmOutputSchema>['data'];

export type TotpRecoveryInput = z.infer<typeof totpRecoveryInputSchema>;
export type TotpRecoveryOutput = z.infer<typeof totpRecoveryOutputSchema>['data'];

export type MeOutput = z.infer<typeof meOutputSchema>['data'];

export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type ChangePasswordOutput = z.infer<typeof changePasswordOutputSchema>['data'];

export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;
export type ForgotPasswordOutput = z.infer<typeof forgotPasswordOutputSchema>['data'];

export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type ResetPasswordOutput = z.infer<typeof resetPasswordOutputSchema>['data'];

export function signup(input: SignupInput): Promise<SignupOutput> {
  return apiFetch<SignupOutput>('/v1/auth/signup', { method: 'POST', body: input });
}

export function verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailOutput> {
  return apiFetch<VerifyEmailOutput>('/v1/auth/verify-email', { method: 'POST', body: input });
}

export async function login(input: LoginInput): Promise<LoginOutput> {
  const result = await apiFetch<LoginOutput>('/v1/auth/login', { method: 'POST', body: input });
  if (result.kind === 'authenticated') {
    setAccessToken(result.accessToken);
    // Tenant isolation (P26b C1 fix round CRITICAL-3): the shared
    // module-level `queryClient` was previously cleared ONLY on logout
    // (`user-menu.tsx`) - every successful login path navigated client-side
    // without clearing it, so a second user signing in on the same tab
    // could see the FIRST user's cached workspace data until a refetch
    // happened to land. Clear it right here, at the exact moment a session
    // actually starts (never on `mfa_required`, which starts no session).
    queryClient.clear();
  }
  return result;
}

export async function totpVerify(input: TotpVerifyInput): Promise<TotpVerifyOutput> {
  const result = await apiFetch<TotpVerifyOutput>('/v1/auth/totp/verify', {
    method: 'POST',
    body: input,
  });
  setAccessToken(result.accessToken);
  queryClient.clear();
  return result;
}

export function totpEnrol(): Promise<TotpEnrolOutput> {
  return apiFetch<TotpEnrolOutput>('/v1/auth/totp/enrol', { method: 'POST' });
}

export function totpEnrolConfirm(input: TotpEnrolConfirmInput): Promise<TotpEnrolConfirmOutput> {
  return apiFetch<TotpEnrolConfirmOutput>('/v1/auth/totp/enrol/confirm', {
    method: 'POST',
    body: input,
  });
}

export async function totpRecovery(input: TotpRecoveryInput): Promise<TotpRecoveryOutput> {
  const result = await apiFetch<TotpRecoveryOutput>('/v1/auth/totp/recovery', {
    method: 'POST',
    body: input,
  });
  setAccessToken(result.accessToken);
  queryClient.clear();
  return result;
}

export function me(): Promise<MeOutput> {
  return apiFetch<MeOutput>('/v1/auth/me');
}

export function logout(): Promise<void> {
  return apiFetch<{ ok: true }>('/v1/auth/logout', { method: 'POST' }).then(() => undefined);
}

export function changePassword(input: ChangePasswordInput): Promise<ChangePasswordOutput> {
  return apiFetch<ChangePasswordOutput>('/v1/auth/password/change', {
    method: 'POST',
    body: input,
  });
}

export function forgotPassword(input: ForgotPasswordInput): Promise<ForgotPasswordOutput> {
  return apiFetch<ForgotPasswordOutput>('/v1/auth/password/forgot', {
    method: 'POST',
    body: input,
  });
}

export function resetPassword(input: ResetPasswordInput): Promise<ResetPasswordOutput> {
  return apiFetch<ResetPasswordOutput>('/v1/auth/password/reset', {
    method: 'POST',
    body: input,
  });
}
