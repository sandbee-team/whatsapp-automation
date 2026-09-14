/**
 * The canonical set of reasons an instance can require explicit user action
 * (P08 session/QR-linking). This is the first place this set is declared -
 * `session-fsm.ts` and its callers use these labels on
 * `InstanceSnapshot.userActionReason` rather than free-form strings, so every
 * "needs user action" surface (dashboard badge, notification copy) can switch
 * exhaustively over a closed set.
 */
export const USER_ACTION_REASONS = [
  'PAIRING_EXPIRED',
  'RECONNECT_FAILED',
  'RESTRICTION_SIGNAL',
  'SESSION_REPLACED',
  'RELINK_REQUIRED',
  'INFRA_UNAVAILABLE',
] as const;

export type UserActionReason = (typeof USER_ACTION_REASONS)[number];
