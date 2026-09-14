/**
 * The QR/pairing-code attempt budget (P08 session/QR-linking): 5 attempts
 * per pairing window before terminal `pairing_expired`. A single source of
 * truth so `engine/session/pairing.ts`'s own default and any caller that
 * needs to compute "attempts left" from a raw `qr_attempts` count (e.g.
 * `instances.routes.ts`'s link-status route) never drift apart.
 */
export const PAIRING_MAX_ATTEMPTS = 5;
