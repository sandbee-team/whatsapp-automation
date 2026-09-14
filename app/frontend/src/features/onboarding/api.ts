import type { z } from 'zod';
import {
  onboardingStatusOutputSchema,
  setConsentInputSchema,
  setPacingProfileInputSchema,
  setTimezoneInputSchema,
} from '@wp/contracts';
import { apiFetch, ApiError } from '../../lib/api-client.js';

export type OnboardingStatus = z.infer<typeof onboardingStatusOutputSchema>['data'];

export type SetTimezoneInput = z.infer<typeof setTimezoneInputSchema>;
export type SetPacingProfileInput = z.infer<typeof setPacingProfileInputSchema>;
export type SetConsentInput = z.infer<typeof setConsentInputSchema>;

interface StepResult {
  step: OnboardingStatus['step'];
}

export function getOnboardingStatus(): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>('/v1/onboarding');
}

export function setTimezone(input: SetTimezoneInput): Promise<StepResult> {
  return apiFetch<StepResult>('/v1/onboarding/timezone', { method: 'POST', body: input });
}

export function setPacingProfile(input: SetPacingProfileInput): Promise<StepResult> {
  return apiFetch<StepResult>('/v1/onboarding/pacing-profile', { method: 'POST', body: input });
}

export function setConsent(input: SetConsentInput): Promise<StepResult> {
  return apiFetch<StepResult>('/v1/onboarding/consent', { method: 'POST', body: input });
}

export interface ConnectInstanceResult {
  status: 'not_available';
}

/**
 * The Connect gate stub (P08 builds the real thing). Only a genuine "not
 * built yet" response (`NOT_IMPLEMENTED`, 501) - or an actual success, once
 * P08 ships - maps to `{status: 'not_available'}` here; every OTHER
 * failure (403 entitlement denial, 429, 500, a network error) rethrows so
 * the caller can tell "the product isn't built yet" apart from "you are
 * not entitled" or "something actually broke" (P04b FIXF, C1 MAJOR-3 - the
 * previous bare catch mapped every failure to `not_available`, misreporting
 * an entitlement denial as an unbuilt product).
 */
export async function connectInstance(): Promise<ConnectInstanceResult> {
  try {
    await apiFetch('/v1/instances', { method: 'POST' });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_IMPLEMENTED') {
      return { status: 'not_available' };
    }
    throw error;
  }
  return { status: 'not_available' };
}
