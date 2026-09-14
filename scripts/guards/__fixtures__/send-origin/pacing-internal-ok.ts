// Known-good fixture for check-send-origin.test.ts (P00 step 7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).
//
// Mirrors app/backend/src/modules/pacing/internal/exemptions.ts - the ONLY
// place the exempt send-origin identifiers may be referenced. Fed to
// scanSendOrigin() under a synthetic path under modules/pacing/internal/, so
// it must never be flagged.

export const SYSTEM_REPLY = 'system_reply';
export const OPT_OUT_CONFIRMATION = 'opt_out_confirmation';

export function isExemptOrigin(origin: string): boolean {
  return origin === SYSTEM_REPLY || origin === OPT_OUT_CONFIRMATION;
}
