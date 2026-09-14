import { assertSchemaVersion, type Queryable } from './assert-schema-version.js';
import { assertNoLiveInstanceIsMissingPacingState } from '../../engine/pacing/provision.js';

/**
 * Thrown when at least one `wallet_accounts` row has `max_rate_minor = 0`
 * (ADR 0019 SS1). Also thrown, fail-closed, when the check itself cannot be
 * performed (the `wp_zero_max_rate_wallet_count()` function is missing, the
 * query errors, anything) - this gate must never fail open.
 */
export class WalletZeroMaxRateError extends Error {
  code = 'WALLET_ZERO_MAX_RATE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletZeroMaxRateError';
  }
}

interface ZeroCountRow {
  zero_count: number | string | null;
}

/**
 * Asserts no `wallet_accounts` row has `max_rate_minor = 0`. Because
 * non-migrate roles connect as a low-privilege role with no BYPASSRLS and
 * `wallet_accounts` will carry FORCE ROW LEVEL SECURITY, this deliberately
 * does NOT query the table directly - a plain `SELECT` with no tenant
 * context would return zero rows for RLS reasons and this gate would
 * silently pass. Instead it calls the SECURITY DEFINER SQL function
 * `public.wp_zero_max_rate_wallet_count()`. Any failure to obtain a count
 * (function missing, query error, anything) throws fail-closed - it never
 * resolves as if the count were zero.
 */
export async function assertNoZeroMaxRateWallet(db: Queryable): Promise<void> {
  let zeroCount: number;

  try {
    const result = await db.query('SELECT public.wp_zero_max_rate_wallet_count() AS zero_count');
    const row = result.rows[0] as ZeroCountRow | undefined;
    // An empty result set means the gate cannot prove anything - it must
    // never be treated as "zero count, all clear" and let the gate pass
    // OPEN. Fail closed, same as a query error.
    if (row === undefined) {
      throw new Error('wp_zero_max_rate_wallet_count() returned an empty result set');
    }
    const rawZeroCount = row.zero_count;
    // A NULL count means the gate cannot prove a count either - it must
    // never be treated as "zero" and let the gate pass OPEN. Fail closed.
    if (rawZeroCount === null) {
      throw new Error('wp_zero_max_rate_wallet_count() returned NULL');
    }
    const parsed = Number(rawZeroCount);
    // A non-finite count (NaN from an unparseable value like 'garbage',
    // Infinity, etc.) must never satisfy `> 0` as false and let the gate
    // pass OPEN - fail closed instead, same as a query error.
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `wp_zero_max_rate_wallet_count() returned a non-finite value: ${String(rawZeroCount)}`,
      );
    }
    zeroCount = parsed;
  } catch (err) {
    throw new WalletZeroMaxRateError(
      `Failed to check for zero-max-rate wallet accounts: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (zeroCount > 0) {
    throw new WalletZeroMaxRateError(`${zeroCount} wallet_accounts row(s) have max_rate_minor = 0`);
  }
}

/**
 * Thrown when `plans` does not carry EXACTLY one `is_default = true` row -
 * zero means signup.service.ts's `readDefaultPlanId` would fail every
 * signup (`NoDefaultPlanError`), more than one is already impossible at the
 * schema layer (migration 0070's `plans_one_default_uq` partial unique
 * index) but is still checked here defensively rather than trusted blindly.
 * Also thrown, fail-closed, when the check itself cannot be performed - same
 * "never pass open" discipline as `WalletZeroMaxRateError`.
 */
export class DefaultPlanMissingError extends Error {
  code = 'DEFAULT_PLAN_MISSING';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DefaultPlanMissingError';
  }
}

interface DefaultPlanCountRow {
  default_count: number | string | null;
}

/** Asserts `plans` carries exactly one `is_default = true` row - see `DefaultPlanMissingError`'s doc comment. */
export async function assertExactlyOneDefaultPlan(db: Queryable): Promise<void> {
  let count: number;

  try {
    const result = await db.query('SELECT count(*) AS default_count FROM plans WHERE is_default');
    const row = result.rows[0] as DefaultPlanCountRow | undefined;
    const raw = row?.default_count ?? null;
    if (raw === null) {
      throw new Error('plans default-count query returned no result');
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`plans default-count query returned a non-finite value: ${String(raw)}`);
    }
    count = parsed;
  } catch (err) {
    throw new DefaultPlanMissingError(
      `Failed to check for a default plan: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (count !== 1) {
    throw new DefaultPlanMissingError(`Expected exactly one default plan, found ${count}`);
  }
}

/**
 * The one function every non-migrate role entrypoint calls before serving
 * any request: schema version, then wallet preconditions, then (session-
 * worker only) the pacing-state provisioning gate.
 *
 * `checkPacingStateProvisioned` is opt-in (default `false`), not a role
 * string: this module has no notion of "which role is this" of its own,
 * and threading one in would duplicate `roles/session-worker.ts` vs
 * `roles/api.ts`'s own identity. `roles/session-worker.ts` passes `true`
 * because a missing `instance_pacing_state` row is a session-worker-only
 * concern (only that role ever claims+reserves a send,
 * `engine/pacing/index.ts#reserve()`); `roles/api.ts` never dispatches a
 * send and must not be blocked from booting by this check.
 *
 * SUPERSEDES `engine/queue/interim-gap.ts`'s `assertPacingLedgerAbsent`
 * (P11's crude in-memory interim floor, RETIRED and DELETED once P13's real
 * durable pacing ledger landed - `pacing_ledger` now legitimately EXISTS,
 * so that self-destruct check would refuse to boot the session-worker role
 * forever). `assertNoLiveInstanceIsMissingPacingState`
 * (`engine/pacing/provision.ts`) is the opposite-direction, POSITIVE check
 * this phase's own boot gate now runs instead: every live instance MUST
 * have a provisioned `instance_pacing_state` row (with no NULL `eff_*`
 * column) before the worker starts claiming, since `reserve()` fails closed
 * (a `NO_LEDGER_ROW`-shaped denial, never a grant) for any instance that
 * lacks one - this boot gate turns that into a loud, immediate refusal to
 * start rather than a quiet per-instance pacing stall discovered later.
 */
export async function assertDbPreconditions(
  db: Queryable,
  options: { checkPacingStateProvisioned?: boolean } = {},
): Promise<void> {
  await assertSchemaVersion(db);
  await assertNoZeroMaxRateWallet(db);
  await assertExactlyOneDefaultPlan(db);
  if (options.checkPacingStateProvisioned) {
    // `provision.ts`'s own `Queryable` declares a GENERIC `query<T>` (any
    // `T extends Record<string, unknown>`); this file's `Queryable`
    // (`assert-schema-version.ts`) declares a narrower, NON-generic
    // `query(): Promise<{rows: unknown[]}>` - not structurally assignable
    // to the generic signature (a generic method must accept ANY `T` the
    // caller asks for, which a fixed `unknown[]` return cannot promise).
    // This adapter re-shapes the same underlying call, never touching
    // `provision.ts` itself (outside this unit's file scope, landed by an
    // earlier unit).
    await assertNoLiveInstanceIsMissingPacingState({
      query: <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => db.query(sql, params) as Promise<{ rows: T[] }>,
    });
  }
}

/**
 * `assertDbPreconditions`, wired to boot: on a thrown assertion error, print
 * only its name/code/message to stderr (never a connection string) and call
 * `exit(1)`. Returns `false` when it exited, `true` when clean - this makes
 * "the process exits non-zero" unit-testable without actually calling
 * `process.exit`.
 */
export async function assertDbPreconditionsOrExit(
  db: Queryable,
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
  options: { checkPacingStateProvisioned?: boolean } = {},
): Promise<boolean> {
  try {
    await assertDbPreconditions(db, options);
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const code =
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${name} (${code}): ${message}`);
    exit(1);
    return false;
  }
}
