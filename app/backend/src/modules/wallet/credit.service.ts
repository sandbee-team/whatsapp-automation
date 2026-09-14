import type { TenantDb, TenantQueryable } from '@wp/db';
import type { WalletState } from '@wp/domain';
import { creditWallet, type CreditWalletInput, type CreditWalletResult } from './credit.repo.js';
import { notifyEmpty, notifyLowIfDue } from './state-notifier.js';
import { publishWakeForClient, type PublishWakeForClientDeps } from './resume-wake.js';

/**
 * credit.service.ts (P19 Unit U4, step 5/6) - the ONE orchestrator that
 * wraps `creditWallet` (`credit.repo.ts`) with: the low/empty state
 * notifications, and the resume wake - all inside/after ONE `withTenant`
 * transaction, exactly the `resume.ts:144` shape (binding correction #3):
 * business writes commit first, then `publishWakeForClient` runs strictly
 * AFTER the transaction resolves - never a Postgres transaction held open
 * across a Redis round trip.
 *
 * TRANSITION DERIVATION (binding correction #4): `creditWallet`'s own SQL
 * result carries no `state` column (only `seq`) - `credit.repo.ts` is
 * frozen (owned by U2, not this unit's scope) - so this service reads the
 * BEFORE state with its own SELECT immediately before calling `creditWallet`
 * and the AFTER state with its own SELECT immediately after, BOTH inside the
 * SAME transaction as the credit itself. This is safe (not a re-read race):
 * the credit's own `UPDATE wallet_accounts` already took the row lock inside
 * this transaction, so a same-transaction follow-up SELECT sees exactly the
 * row the credit just committed to, never a concurrent writer's value - no
 * other transaction can modify this row until this one commits or rolls
 * back. A replayed credit (`result.replayed === true`) still re-reads the
 * CURRENT state (which never changed under a replay) - notifying again
 * would be wrong, so replay short-circuits notification/wake entirely
 * before either state read (see below).
 *
 * WAKE GATE (binding correction #4): a wake/notify fires ONLY on a genuine
 * `empty|frozen -> active|low` transition - `frozen -> frozen` (still
 * absorbing, still un-claimable) and `active -> active` (never stopped)
 * publish/notify NOTHING.
 */

export interface CreditWalletServiceDeps {
  tenantDb: TenantDb;
  publishWake: PublishWakeForClientDeps['publishWake'];
  nowMs: number;
  onWakePublishError?: (clientId: string, instanceId: string, err: unknown) => void;
}

/** The subset of `CreditWalletServiceDeps` `creditWalletInTx` actually needs - no `tenantDb`/`publishWake` (the caller already owns the transaction and the wake). */
export type CreditWalletInTxDeps = Pick<CreditWalletServiceDeps, 'nowMs'>;

export interface CreditWalletServiceResult extends CreditWalletResult {
  stateBefore: WalletState;
  stateAfter: WalletState;
  /** True only when this credit actually fired a resume wake (a genuine zero-claim -> claimable transition, and not a replay). */
  wokeInstances: boolean;
}

interface WalletStateRow extends Record<string, unknown> {
  state: WalletState;
}

interface QueuedCountRow extends Record<string, unknown> {
  count: string;
}

async function readWalletState(tx: TenantQueryable, clientId: string): Promise<WalletState> {
  const result = await tx.query<WalletStateRow>(
    `SELECT state FROM wallet_accounts WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`credit.service: no wallet_accounts row for client=${clientId}`);
  }
  return row.state;
}

async function countQueuedJobs(tx: TenantQueryable, clientId: string): Promise<number> {
  const result = await tx.query<QueuedCountRow>(
    `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND status = 'queued'`,
    [clientId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** empty|frozen -> active|low is the only transition that ever wakes/notifies (binding correction #4). */
function isZeroClaimToClaimable(before: WalletState, after: WalletState): boolean {
  const wasZeroClaim = before === 'empty' || before === 'frozen';
  const isNowClaimable = after === 'active' || after === 'low';
  return wasZeroClaim && isNowClaimable;
}

/**
 * The in-transaction core of `creditWalletAndNotify` - runs `creditWallet`
 * plus the low/empty state notifications on the CALLER's own transaction
 * (`tx`), never opening one itself. `with-staff-mutation.ts`'s money routes
 * (`wallet.credit`/`wallet.adjust`/`topups.approve`) call this DIRECTLY
 * inside `withStaffMutation`'s own transaction, so the credit and the audit
 * row commit atomically together - `creditWalletAndNotify` below still wraps
 * this in its own `withTenant` for every OTHER existing caller (unchanged
 * behaviour, same public contract).
 */
export async function creditWalletInTx(
  tx: TenantQueryable,
  deps: CreditWalletInTxDeps,
  input: CreditWalletInput,
): Promise<Omit<CreditWalletServiceResult, 'wokeInstances'>> {
  const stateBefore = await readWalletState(tx, input.clientId);
  const creditResult = await creditWallet(tx, input);

  if (creditResult.replayed) {
    // A replay moved no money and changed no state - re-reading "after"
    // would just echo "before" (harmless) but notifying would be a lie
    // (nothing actually transitioned this call).
    return { ...creditResult, stateBefore, stateAfter: stateBefore };
  }

  // `wallet-credit.sql`'s own CASE (byte-identical in shape to
  // `nextWalletState`, per that SQL file's own header) already computed
  // this - this SELECT just reads it back; `credit.integration.test.ts`'s
  // own boundary sweep is what proves the two agree, not this file.
  const stateAfter = await readWalletState(tx, input.clientId);

  if (stateAfter === 'low') {
    await notifyLowIfDue(tx, { nowMs: deps.nowMs }, input.clientId);
  } else if (stateAfter === 'empty') {
    const queued = await countQueuedJobs(tx, input.clientId);
    await notifyEmpty(tx, input.clientId, queued);
  }

  return { ...creditResult, stateBefore, stateAfter };
}

/**
 * Credits a wallet, notifies on a genuine low/empty state entry, and wakes
 * every non-deleted instance of the client on a zero-claim -> claimable
 * transition - see module header for the full contract. Opens its OWN
 * `withTenant` transaction around `creditWalletInTx`, then wakes strictly
 * after commit.
 */
export async function creditWalletAndNotify(
  deps: CreditWalletServiceDeps,
  input: CreditWalletInput,
): Promise<CreditWalletServiceResult> {
  // MINOR 7 (P19 C1 review round): deliberately left unset rather than
  // seeded with a `{ seq: '0', replayed: true }` silent-success default - if
  // `withTenant` ever returned without running its callback, a seeded
  // default would report success having written nothing (and the caller
  // would then skip its audit row for a mutation that never happened). The
  // throw below makes that failure mode loud instead.
  let inTxResult: Awaited<ReturnType<typeof creditWalletInTx>> | undefined;

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    inTxResult = await creditWalletInTx(tx, { nowMs: deps.nowMs }, input);
  });

  if (inTxResult === undefined) {
    throw new Error(
      `creditWalletAndNotify: withTenant returned without running its callback for client=${input.clientId} - refusing to report a silent success`,
    );
  }

  const { stateBefore, stateAfter } = inTxResult;
  const shouldWake = !inTxResult.replayed && isZeroClaimToClaimable(stateBefore, stateAfter);

  if (shouldWake) {
    // Strictly AFTER the credit transaction above has already committed
    // (binding correction #3) - this read-only `withTenant` call is a NEW,
    // separate transaction, never the same one the credit ran on.
    await deps.tenantDb.withTenant(input.clientId, (tx) =>
      publishWakeForClient(
        { db: tx, publishWake: deps.publishWake, onPublishError: deps.onWakePublishError },
        input.clientId,
      ),
    );
  }

  return { ...inTxResult, wokeInstances: shouldWake };
}
