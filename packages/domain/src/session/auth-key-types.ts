/**
 * Baileys auth-key type classification (P07 Unit U1, ADR pending).
 *
 * Pinned `baileys@7.0.0-rc14`'s `SignalDataTypeMap` has exactly TEN key
 * types. This module is the domain-owned, browser-safe tier assignment for
 * all ten (parity with the pinned library is proved separately, in
 * `app/backend/src/provider/baileys/auth-state/key-type-parity.test.ts`,
 * which is allowed to import baileys - this package never does).
 *
 * Tiers:
 *   - durable     -> Postgres, non-rebuildable. Losing these loses
 *                    unrecoverable Signal/session state.
 *   - signal      -> Redis noeviction tier. `identity-key` is Signal trust
 *                    material - an eviction here would silently re-TOFU
 *                    (trust-on-first-use) a peer, which must never happen
 *                    silently.
 *   - rebuildable -> Redis allkeys-lru cache tier. All four of these are
 *                    re-queryable from the WhatsApp server, so losing a
 *                    cached entry is a re-fetch, not data loss.
 *
 * `classifyAuthKeyType` throws `UnknownAuthKeyTypeError` on anything not in
 * the ten - core invariant 2 (fail-safe): an unrecognized key type is never
 * silently defaulted into a tier (e.g. Redis), because the wrong tier for an
 * unknown type could silently drop durable, non-rebuildable auth material.
 *
 * Browser-safe (no Node builtins, no baileys import) - depcruise rule
 * `domain-must-be-pure-core` enforces this at the package boundary; this
 * module defines its own string-literal `AuthKeyType`, it never imports
 * baileys' `SignalDataTypeMap` type.
 */

export const DURABLE_KEY_TYPES = [
  'pre-key',
  'app-state-sync-key',
  'app-state-sync-version',
] as const;

export const SIGNAL_KEY_TYPES = ['session', 'sender-key', 'identity-key'] as const;

export const REBUILDABLE_KEY_TYPES = [
  'sender-key-memory',
  'lid-mapping',
  'device-list',
  'tctoken',
] as const;

export type DurableAuthKeyType = (typeof DURABLE_KEY_TYPES)[number];
export type SignalAuthKeyType = (typeof SIGNAL_KEY_TYPES)[number];
export type RebuildableAuthKeyType = (typeof REBUILDABLE_KEY_TYPES)[number];

export type AuthKeyType = DurableAuthKeyType | SignalAuthKeyType | RebuildableAuthKeyType;

export type AuthKeyTier = 'durable' | 'signal' | 'rebuildable';

/** Signal auth-key Redis TTL: 30 days. */
export const SIGNAL_KEY_TTL_MS = 2_592_000_000;

/** Cap on tracked group-participant devices (device-list fan-out bound). */
export const MAX_TRACKED_GROUP_PARTICIPANT_DEVICES = 2000;

export class UnknownAuthKeyTypeError extends Error {
  readonly authKeyType: string;

  constructor(authKeyType: string) {
    super(`unknown auth key type "${authKeyType}" - refusing to guess a storage tier`);
    this.name = 'UnknownAuthKeyTypeError';
    this.authKeyType = authKeyType;
  }
}

const TIER_BY_TYPE: ReadonlyMap<string, AuthKeyTier> = new Map([
  ...DURABLE_KEY_TYPES.map((type) => [type, 'durable'] as const),
  ...SIGNAL_KEY_TYPES.map((type) => [type, 'signal'] as const),
  ...REBUILDABLE_KEY_TYPES.map((type) => [type, 'rebuildable'] as const),
]);

/**
 * Classifies an auth key type into its storage tier. Throws
 * `UnknownAuthKeyTypeError` (never returns a default tier) for anything
 * outside the ten pinned `SignalDataTypeMap` keys.
 */
export function classifyAuthKeyType(type: string): AuthKeyTier {
  const tier = TIER_BY_TYPE.get(type);
  if (tier === undefined) {
    throw new UnknownAuthKeyTypeError(type);
  }
  return tier;
}
