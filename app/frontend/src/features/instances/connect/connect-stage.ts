import { z } from 'zod';
import { phoneE164Schema } from '@wp/contracts';
import type { NoFreeSlotDetails } from '../api.js';

/**
 * connect-stage.ts (P08 U7) - the `ConnectSheet` state machine shape, split
 * out of `useConnectFlow.ts`/`ConnectSheet.tsx` so both can import the same
 * type without a circular import. Kept as one discriminated `stage` union
 * rather than several booleans, so an invalid combination (e.g. "showing the
 * QR panel with no instanceId") is unrepresentable.
 */
export type ConnectStage =
  | { name: 'create' }
  | { name: 'method'; instanceId: string }
  | { name: 'phone'; instanceId: string }
  | { name: 'challenge'; instanceId: string; method: 'qr' | 'code' }
  | { name: 'connected'; maskedNumber: string | null }
  | { name: 'parked' }
  | { name: 'noFreeSlot'; instanceId: string; holders: NoFreeSlotDetails['holders'] }
  | { name: 'mfa'; reason: 'enrol' | 'verify' };

export const phoneFormSchema = z.object({ phone: phoneE164Schema });
export type PhoneFormInput = z.infer<typeof phoneFormSchema>;

/**
 * Maps the two-factor error codes the create/link calls can return to the
 * `'mfa'` stage's `reason` - `MFA_ENROLL_REQUIRED` (no TOTP enrolled yet) vs
 * `MFA_REQUIRED` (enrolled, but this session was never verified). Any other
 * code returns `null` so callers fall back to their existing generic error
 * handling unchanged.
 */
export function mfaReasonForErrorCode(code: string): 'enrol' | 'verify' | null {
  if (code === 'MFA_ENROLL_REQUIRED') return 'enrol';
  if (code === 'MFA_REQUIRED') return 'verify';
  return null;
}
