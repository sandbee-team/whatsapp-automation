import { DisconnectReason } from 'baileys';

/**
 * pinned.ts (P08 U1 step 1) - the single source of truth for "which Baileys
 * version WP is built against" plus a plain-object, re-derived snapshot of
 * the live `DisconnectReason` enum.
 *
 * WHY a snapshot instead of importing `DisconnectReason` directly wherever a
 * numeric code is needed: `disconnect-map.ts`'s data table is keyed by
 * number and must never rely on the enum's *shape* changing silently across
 * a Baileys upgrade without a test failing loudly. `pinned.test.ts` asserts
 * this snapshot equals the live enum member-for-member (both directions), so
 * a future `rc15` that adds/removes/renumbers a `DisconnectReason` member
 * fails this test rather than drifting unnoticed into `disconnect-map.ts`.
 */
export const BAILEYS_PINNED_VERSION = '7.0.0-rc14' as const;

/** The date `DISCONNECT_REASON_SNAPSHOT` below was last re-derived from the pinned package. */
export const ENUM_REDERIVED_ON = '2026-08-31' as const;

/**
 * Re-derived from `baileys@7.0.0-rc14`'s live `DisconnectReason` enum
 * (numeric enum with reverse string mappings, hence both directions
 * appearing as own-enumerable keys - `pinned.test.ts` snapshots and checks
 * both). Do not hand-edit; regenerate by reading the live enum and re-run
 * the snapshot-parity test.
 */
export const DISCONNECT_REASON_SNAPSHOT: Readonly<Record<string, number | string>> = Object.freeze({
  ...(DisconnectReason as unknown as Record<string, number | string>),
});
