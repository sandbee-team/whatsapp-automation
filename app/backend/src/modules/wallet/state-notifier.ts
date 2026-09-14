import { loadNamedQuery, bindQueryParams, type TenantQueryable } from '@wp/db';
import { notify } from '../notifications/index.js';
import {
  bindWalletMetrics,
  type WalletMetricsHandles,
} from '../../platform/metrics/wallet-metrics.js';

/**
 * state-notifier.ts (P19 Unit U4, step 6) - `notifyWalletStateChange`, the
 * ONE place a wallet-state-changing statement's caller reports a
 * `low`/`empty` entry, so `notify()` fires with the correct dedupe key.
 * Called on the SAME `tx` the credit/debit statement itself ran on, inside
 * the same transaction (never a detached fire-and-forget) - mirrors
 * `engine/pacing/index.ts`'s own `plan_cap_reached` call site exactly.
 *
 * DEDUPE KEY MAPPING (binding correction #6 - do not re-derive): the phase
 * asks for `wallet:low:{client}:{yyyy-mm-dd}` / `wallet:empty:{client}:
 * {last_empty_at}`, reproduced through the EXISTING `notify()` mechanism,
 * never a second dedupe path:
 *
 *   - `wallet_low` -> `dedupeScope: 'instance-day'` (kinds.ts), `bucket` =
 *     the UTC calendar-date string for "now" (injected `nowMs`, never
 *     `Date.now()` read here), `transitionId` = the client id (wallet
 *     notifications carry no `instanceId` - client-level).
 *   - `wallet_empty` -> `dedupeScope: 'transition'`, `transitionId` = the
 *     `last_empty_at` value the state change ITSELF wrote (read back from
 *     `wallet-state-warned.sql`'s `wallet-empty-stamp` RETURNING, never a
 *     wall-clock value read here - dedupe-key.ts's own rule).
 *
 * ONCE-PER-24H AUTHORITY (binding correction #7): `wallet-low-warn-gate`
 * (`db/queries/wallet-state-warned.sql`) is a conditional UPDATE of
 * `wallet_accounts.last_low_warning_at` that only matches a row when it has
 * genuinely been >= 24h (or never) - this is the STORAGE-layer idempotency
 * authority (core invariant 3), not an in-memory check. `notifyLowIfDue`
 * calls `notify()` ONLY when that statement's RETURNING produced a row;
 * zero rows (still inside the 24h window) is a normal, silent no-op.
 */

export interface StateNotifierDeps {
  /** Epoch ms "now" - injected, never read from `Date.now()` inside this module (fake-clock discipline). */
  nowMs: number;
  metrics?: Pick<WalletMetricsHandles, 'setClientsEmpty'>;
}

function utcDateBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Runs the once-per-24h gate and, only when it actually fires, `notify()`s
 * `wallet_low` - dedupeScope 'instance-day' (bucket = today's UTC date,
 * transitionId = clientId). Returns whether a notification was actually
 * created (never created on a within-24h repeat).
 */
export async function notifyLowIfDue(
  tx: TenantQueryable,
  deps: StateNotifierDeps,
  clientId: string,
): Promise<boolean> {
  const gateQuery = await loadNamedQuery('wallet-state-warned', 'wallet-low-warn-gate');
  const gateResult = await tx.query<{ last_low_warning_at: string }>(
    gateQuery.text,
    bindQueryParams(gateQuery, { client: clientId }),
  );
  if (gateResult.rows.length === 0) {
    return false;
  }

  const result = await notify(tx, {
    clientId,
    kind: 'wallet_low',
    transitionId: clientId,
    bucket: utcDateBucket(deps.nowMs),
    payload: {},
  });
  return result.created;
}

/**
 * Stamps `last_empty_at` (the transition's own identity, see module header)
 * and `notify()`s `wallet_empty` with that exact stamp as `transitionId` -
 * dedupeScope 'transition', so a replay against the SAME stamp dedupes but a
 * genuinely new empty-crossing (a fresh `now()` stamp) always notifies once.
 */
export async function notifyEmpty(
  tx: TenantQueryable,
  clientId: string,
  queued: number,
): Promise<boolean> {
  const stampQuery = await loadNamedQuery('wallet-state-warned', 'wallet-empty-stamp');
  const stampResult = await tx.query<{ last_empty_at: string }>(
    stampQuery.text,
    bindQueryParams(stampQuery, { client: clientId }),
  );
  const lastEmptyAt = stampResult.rows[0]?.last_empty_at;
  if (lastEmptyAt === undefined) {
    // No wallet_accounts row for this client - nothing to stamp/notify.
    return false;
  }

  const result = await notify(tx, {
    clientId,
    kind: 'wallet_empty',
    transitionId: lastEmptyAt,
    payload: { queued },
  });
  return result.created;
}

/** `wp_wallet_clients_empty` - see `platform/metrics/wallet-metrics.ts`'s own doc for why this is unlabelled. Callers (the reconciler sweep) already own setting this; re-exported here only so state-notifier.ts's own callers can reach the same handle without a second import. */
export function bindStateNotifierMetrics(): Pick<WalletMetricsHandles, 'setClientsEmpty'> {
  return bindWalletMetrics();
}
