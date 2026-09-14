/**
 * scripts/ops/restore-drill-metrics.ts (P29a Unit U3, step 9) - PURE metric
 * computations for the restore drill. Lives under `scripts/ops/` (a
 * composite TS project `app/backend` already references) rather than
 * `infra/backup/` so `app/backend/src/engine/measure/run-restore-verify-
 * extra.ts` can import it without crossing a project-reference boundary
 * `app/backend/tsconfig.json` does not declare (that boundary rule is not
 * this unit's to change - see the sibling `restore-drill-lib.ts` in
 * `infra/backup/`, which re-exports these same functions for its own
 * callers, so `infra/backup/restore-drill.ts` and its tests are unaffected).
 */

export interface LedgerRow {
  client_id: string;
  seq: number | string;
  amount_minor: number | string;
  balance_after_minor: number | string;
}

export interface LedgerBreak {
  client_id: string;
  seq: string;
  expected: string;
  actual: string;
}

export interface LedgerChainResult {
  clientsChecked: number;
  rowsChecked: number;
  breaks: LedgerBreak[];
}

/**
 * The wallet_ledger continuity invariant: per client, ordered by `seq`,
 * `balance_after_minor = lag(balance_after_minor) + amount_minor` (the
 * first row per client has no lag, so `balance_after_minor = amount_minor`).
 * Bigint-safe throughout (ledger amounts can exceed `Number.MAX_SAFE_INTEGER`
 * only in pathological cases, but the contract is bigint regardless).
 *
 * `rows` need not be pre-sorted; this function groups by `client_id` and
 * sorts each group by `seq` itself, so callers (e.g. a `ORDER BY client_id,
 * seq` SQL result, or a fixture in any order) both work identically.
 */
export function evaluateLedgerChain(rows: readonly LedgerRow[]): LedgerChainResult {
  const byClient = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const group = byClient.get(row.client_id);
    if (group === undefined) {
      byClient.set(row.client_id, [row]);
    } else {
      group.push(row);
    }
  }

  const breaks: LedgerBreak[] = [];
  let rowsChecked = 0;

  for (const [clientId, group] of byClient) {
    const sorted = [...group].sort((a, b) => {
      const seqA = BigInt(a.seq);
      const seqB = BigInt(b.seq);
      if (seqA < seqB) return -1;
      if (seqA > seqB) return 1;
      return 0;
    });
    let previousBalance: bigint | undefined;
    for (const row of sorted) {
      rowsChecked += 1;
      const amount = BigInt(row.amount_minor);
      const actual = BigInt(row.balance_after_minor);
      const expected = previousBalance === undefined ? amount : previousBalance + amount;
      if (expected !== actual) {
        breaks.push({
          client_id: clientId,
          seq: String(row.seq),
          expected: expected.toString(),
          actual: actual.toString(),
        });
      }
      previousBalance = actual;
    }
  }

  return { clientsChecked: byClient.size, rowsChecked, breaks };
}

export interface ComputeRecoveryPointInput {
  backupEndIso: string;
  lastReplayIso: string | null;
  drillStartIso: string;
}

export interface RecoveryPointResult {
  recoveryPointIso: string;
  rpoSeconds: number;
  rpoTargetSeconds: 300;
  ok: boolean;
}

/**
 * With `recovery_target = 'immediate'` (the pgBackRest PITR mode's own
 * target - see `buildPgBackRestRestoreArgv` in `infra/backup/restore-drill-
 * lib.ts`), Postgres promotes at the FIRST consistent point, which is the
 * backup END time, not the archive's newest WAL - so the recovery point IS
 * `backupEndIso` whenever no later replay point is known. `lastReplayIso`,
 * when given (a real archive-based PITR replayed further), overrides it.
 */
export function computeRecoveryPoint(input: ComputeRecoveryPointInput): RecoveryPointResult {
  const recoveryPointIso = input.lastReplayIso ?? input.backupEndIso;
  const rpoSeconds = Math.max(
    0,
    Math.round(
      (new Date(input.drillStartIso).getTime() - new Date(recoveryPointIso).getTime()) / 1000,
    ),
  );
  const rpoTargetSeconds = 300;
  return { recoveryPointIso, rpoSeconds, rpoTargetSeconds, ok: rpoSeconds <= rpoTargetSeconds };
}

export interface ComputeRtoInput {
  restoreStartIso: string;
  verifiedAtIso: string;
}

export interface RtoResult {
  rtoMs: number;
  rtoTargetMs: 3_600_000;
  tier: '<=2000' | '5000' | '10000';
  ok: boolean;
}

/**
 * RTO = restore start -> verified. `tier` here is always the launch tier
 * (`<=2000`) - the ADR 0018 §7 per-tier claim is computed from the
 * RESTORED instance count by `deriveAdr0018Tier`
 * (`run-restore-verify-checks.ts`), never re-derived here; this function
 * only measures against the launch-tier target the phase names.
 */
export function computeRto(input: ComputeRtoInput): RtoResult {
  const rtoMs = new Date(input.verifiedAtIso).getTime() - new Date(input.restoreStartIso).getTime();
  const rtoTargetMs = 3_600_000;
  return { rtoMs, rtoTargetMs, tier: '<=2000', ok: rtoMs <= rtoTargetMs };
}
