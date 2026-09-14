import { bindQueryParams, loadNamedQuery, type TenantDb, type TenantQueryable } from '@wp/db';
import { resolvePriceKey, type PriceKey } from '@wp/domain';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';
import { resolveRateMinor } from './pricing.js';

/**
 * charge.ts (P18 Unit U3) - the guard-first debit's TypeScript half, wired
 * over `db/queries/debit-send.sql` (see that file's own header for the full
 * lock-order/idempotency contract; this module owns none of that logic
 * itself, only the two-statement call sequence + repair-path pricing).
 * LOCK ORDER: message_jobs -> send_attempts -> wallet_accounts
 * (-> campaign_counters, P23). The only caller of `debit-send` /
 * `debit-repaired-send` in this codebase is `engine/queue/result.ts`
 * (`resolveAck`'s second transaction) and, for the repair path, the
 * reaper/reconciler (later phase).
 */

export interface ChargeSendInput {
  attemptId: string;
  jobId: string;
  leaseId: string;
  clientId: string;
  priceKey: PriceKey;
  rateMinor: number;
}

export interface ChargeResult {
  jobRows: number;
  guardRows: number;
  seq: string | null;
}

/**
 * Runs `debit-send` (job-outcome UPDATE chained into the guard-first
 * charge); when a ledger row was actually written (`seq !== null`), stamps
 * the guard's `ledger_seq` in a second statement, same transaction. Does
 * NOT throw on `jobRows === 0` - the caller (`result.ts`) decides what a
 * zero-row job UPDATE means (`ClaimLostDuringSend`); never touches
 * metrics/logging itself.
 */
export async function chargeSend(
  tx: TenantQueryable,
  input: ChargeSendInput,
): Promise<ChargeResult> {
  const debitQuery = await loadNamedQuery('debit-send', 'debit-send');
  const debitResult = await tx.query<{ job_rows: number; guard_rows: number; seq: string | null }>(
    debitQuery.text,
    bindQueryParams(debitQuery, {
      jid: input.jobId,
      lease: input.leaseId,
      client: input.clientId,
      attempt: input.attemptId,
      rate: input.rateMinor,
      price_key: input.priceKey,
    }),
  );
  const row = debitResult.rows[0];
  const result: ChargeResult = {
    jobRows: row?.job_rows ?? 0,
    guardRows: row?.guard_rows ?? 0,
    seq: row?.seq ?? null,
  };

  if (result.seq !== null) {
    const stampQuery = await loadNamedQuery('debit-send', 'wallet-stamp-guard');
    await tx.query(
      stampQuery.text,
      bindQueryParams(stampQuery, {
        seq: result.seq,
        attempt: input.attemptId,
        kind: 'debit_send',
        client: input.clientId,
      }),
    );
  }

  return result;
}

export interface ChargeRepairedSendInput {
  clientId: string;
  attemptId: string;
}

export interface ChargeRepairedSendDeps {
  metrics?: Pick<WalletMetricsHandles, 'incDebit'>;
}

export interface ResolvedAttemptPrice {
  priceKey: PriceKey;
  rateMinor: number;
}

/**
 * Looks up the price key and effective rate for a settled send attempt,
 * from the attempt+job row's own `payload_kind`/`recipient_jid` (the same
 * derivation `chargeRepairedSend` needs before it can charge). Returns
 * `null` (never throws) when `attemptId` is unknown for `clientId` - the
 * caller decides what an unresolvable attempt means. NEVER logs
 * `recipient_jid` (phone-shaped) or any message body.
 */
export async function resolveAttemptPrice(
  tx: TenantQueryable,
  clientId: string,
  attemptId: string,
): Promise<ResolvedAttemptPrice | null> {
  const attemptRow = await tx.query<{ payload_kind: string; recipient_jid: string }>(
    `SELECT j.payload_kind, j.recipient_jid
       FROM send_attempts a
       JOIN message_jobs j ON j.id = a.message_job_id AND j.created_at = a.message_job_created_at
      WHERE a.id = $1 AND a.client_id = $2 -- client_id = $2`,
    [attemptId, clientId],
  );
  const found = attemptRow.rows[0];
  if (!found) {
    return null;
  }

  const priceKey = resolvePriceKey({
    payloadKind: found.payload_kind,
    recipientJid: found.recipient_jid,
  });
  const rateMinor = await resolveRateMinor(tx, clientId, priceKey);
  return { priceKey, rateMinor };
}

/**
 * Repair path: charges a job the reaper/reconciler already repaired to
 * 'sent' but `result.ts` never got to charge. Runs entirely inside ONE
 * `withTenant` transaction. Returns `{jobRows: 0, guardRows: 0, seq: null}`
 * (no throw) when `attemptId` is unknown for `clientId` - the repair
 * pipeline decides what an unresolvable attempt means, not this function.
 * NEVER logs `recipient_jid` (phone-shaped) or any message body.
 */
export async function chargeRepairedSend(
  tenantDb: TenantDb,
  input: ChargeRepairedSendInput,
  deps: ChargeRepairedSendDeps,
): Promise<ChargeResult> {
  return tenantDb.withTenant(input.clientId, async (tx) => {
    const resolved = await resolveAttemptPrice(tx, input.clientId, input.attemptId);
    if (!resolved) {
      return { jobRows: 0, guardRows: 0, seq: null };
    }
    const { priceKey, rateMinor } = resolved;

    const debitQuery = await loadNamedQuery('debit-send', 'debit-repaired-send');
    const debitResult = await tx.query<{
      job_rows: number;
      guard_rows: number;
      seq: string | null;
    }>(
      debitQuery.text,
      bindQueryParams(debitQuery, {
        attempt: input.attemptId,
        client: input.clientId,
        rate: rateMinor,
        price_key: priceKey,
      }),
    );
    const row = debitResult.rows[0];
    const result: ChargeResult = {
      jobRows: row?.job_rows ?? 0,
      guardRows: row?.guard_rows ?? 0,
      seq: row?.seq ?? null,
    };

    if (result.seq !== null) {
      const stampQuery = await loadNamedQuery('debit-send', 'wallet-stamp-guard');
      await tx.query(
        stampQuery.text,
        bindQueryParams(stampQuery, {
          seq: result.seq,
          attempt: input.attemptId,
          kind: 'debit_send',
          client: input.clientId,
        }),
      );
      deps.metrics?.incDebit(priceKey);
    }

    return result;
  });
}
