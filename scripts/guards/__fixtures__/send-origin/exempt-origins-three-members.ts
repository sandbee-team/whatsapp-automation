// Known-bad fixture for check-send-origin.test.ts clause 3 (P14 Unit U7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).
//
// A THIRD member added to EXEMPT_ORIGINS - the guard must flag this: the
// exempt set is only ever allowed to be exactly {'system_reply',
// 'opt_out_confirmation'}, never a superset.

export const SEND_ORIGINS = [
  'campaign',
  'api_send',
  'inbox_manual',
  'system_reply',
  'opt_out_confirmation',
] as const;

export type SendOrigin = (typeof SEND_ORIGINS)[number];

export const EXEMPT_ORIGINS = Object.freeze([
  'system_reply',
  'opt_out_confirmation',
  'inbox_manual',
] as const);
