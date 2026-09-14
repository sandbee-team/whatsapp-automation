import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { TenantQueryable } from '@wp/db';
import { open, seal } from '@wp/server-kit/crypto';
import { generateSecret, generateURI, verify as otpVerify } from 'otplib';
import * as identityRepoDefault from './identity.repo.js';
import { sysKey } from '../../platform/redis.js';
import {
  sealParamsFor,
  openParamsFor,
  sealedBlobToBytes,
  bytesToSealedBlob,
  sha256,
  generateRecoveryCode,
} from './totp-secret.js';

/**
 * totp.service.ts (P04a Unit UA5b) - TOTP MFA enrolment/verification and
 * one-time-use recovery codes. Canon (binding, see the phase task):
 *  - The TOTP secret is NEVER stored in plaintext: sealed via
 *    `@wp/server-kit`'s envelope crypto (purpose `user-secrets`) before it
 *    ever reaches `users.mfa_totp_secret_enc`.
 *  - Replay rejection happens at the Redis layer (`SET NX` + TTL) - a Redis
 *    ERROR denies (fail CLOSED, core invariant 2); it never falls open.
 *  - Recovery codes are one-time-use at the STORAGE layer (a single
 *    conditional `UPDATE ... WHERE used_at IS NULL`), never an in-memory
 *    check (core invariant 3) - see `identity.repo.ts#claimMfaRecoveryCode`.
 *  - `users`/`mfa_recovery_codes` carry no `client_id`/RLS (identity is
 *    global - migration 0005's "NON-tenant tables" comment), same class as
 *    the rest of `identity.repo.ts`.
 */

export class MfaNotEnrolledError extends Error {
  readonly code = 'MFA_NOT_ENROLLED';
  constructor() {
    super('TOTP MFA is not enrolled for this account.');
    this.name = 'MfaNotEnrolledError';
  }
}

export class InvalidTotpCodeError extends Error {
  readonly code = 'INVALID_TOTP_CODE';
  constructor() {
    super('Invalid or already-used TOTP code.');
    this.name = 'InvalidTotpCodeError';
  }
}

export class InvalidRecoveryCodeError extends Error {
  readonly code = 'INVALID_RECOVERY_CODE';
  constructor() {
    super('Invalid or already-used recovery code.');
    this.name = 'InvalidRecoveryCodeError';
  }
}

/**
 * FIX 11a (P04a FIXB): re-enrolling an already-enrolled account needs a
 * re-auth-gated reset flow (P04b) - not implemented here, so both
 * `enrolStart` and `enrolConfirm` reject outright while `mfa_enabled_at` is
 * already set, rather than silently accumulating a second live secret/second
 * batch of recovery codes underneath the first.
 */
export class MfaAlreadyEnrolledError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('TOTP MFA is already enrolled for this account.');
    this.name = 'MfaAlreadyEnrolledError';
  }
}

const TOTP_ISSUER = 'WP';
const TOTP_PERIOD_SEC = 30;
const RECOVERY_CODE_COUNT = 10;

type IdentityRepo = typeof identityRepoDefault;

/**
 * FIX 11b (P04a FIXB): `enrolConfirm` needs a REAL transaction (delete-then-
 * verify-then-set-then-insert-10, atomically), so this ctx ALSO carries a
 * connectable `pool` - the same `connect()`/`release()` shape
 * `login.service.ts`'s `LoginDbPool`/`LoginDbClient` already uses. Kept as a
 * SEPARATE field from `db` (rather than widening `db` itself) because a real
 * `pg.PoolClient` (identity.routes.ts's `/totp/verify` handler, FIX 10,
 * passes its OWN already-open transaction client as `db`) already has its
 * OWN unrelated `connect(): Promise<void>` (inherited from `pg.Client`,
 * "open this connection") that would otherwise collide with this
 * "hand me a NEW client" meaning.
 */
export interface TotpDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface TotpDbPool extends TenantQueryable {
  connect(): Promise<TotpDbClient>;
}

export interface TotpCtx {
  db: TenantQueryable;
  /** Only required by `enrolConfirm` - see the doc comment above. */
  pool: TotpDbPool;
  redis: Redis;
  /** Path to the JSON key ring (FileKeyProvider) - platform/config.ts's KEY_RING_PATH. */
  keyRingPath: string;
  /** Number of +/- 30s periods of clock drift tolerated (platform/config.ts's TOTP_WINDOW). */
  totpWindow: number;
  /** TTL (seconds) of the Redis used-code replay-rejection marker. */
  totpUsedCodeTtlSec: number;
  /** Namespacing segment for the Redis key (`wp:{env}:totp:used:u:{userId}:{code}`). */
  env: string;
  now?: () => Date;
  /** Test-double injection point - never used in production wiring. */
  identityRepo?: Partial<IdentityRepo>;
}

function usedCodeRedisKey(env: string, userId: string, code: string): string {
  return sysKey(env, 'totp', 'used', 'u', userId, code);
}

export interface EnrolStartResult {
  otpauthUrl: string;
  /** The raw base32 secret - shown to the user exactly once (via QR/manual entry), never persisted in plaintext. */
  secretShownOnce: string;
}

/**
 * Starts TOTP enrolment: generates a fresh secret, seals it, and persists
 * ONLY the sealed form. Does NOT set `mfa_enabled_at` - enrolment is not
 * complete until `enrolConfirm` proves the user's authenticator app actually
 * has the secret.
 */
export async function enrolStart(
  ctx: TotpCtx,
  userId: string,
  accountLabel: string,
): Promise<EnrolStartResult> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };

  // FIX 11a (P04a FIXB): re-enrolment while already enrolled is a re-auth-
  // gated reset flow (P04b) - not implemented here.
  const existing = await identityRepo.getUserTotpState(ctx.db, userId);
  if (existing?.mfaEnabledAt) {
    throw new MfaAlreadyEnrolledError();
  }

  const secret = generateSecret();
  const blob = seal(Buffer.from(secret, 'utf8'), sealParamsFor(ctx, userId));
  await identityRepo.setUserTotpSecretEnc(ctx.db, userId, sealedBlobToBytes(blob));

  const otpauthUrl = generateURI({
    issuer: TOTP_ISSUER,
    label: accountLabel,
    secret,
    period: TOTP_PERIOD_SEC,
  });

  return { otpauthUrl, secretShownOnce: secret };
}

export interface EnrolConfirmResult {
  /** The 10 raw recovery codes - returned exactly once; only their SHA-256 hashes are ever stored. */
  recoveryCodes: string[];
}

/**
 * Confirms enrolment: opens the sealed secret, verifies `code` against it,
 * and on success sets `mfa_enabled_at` and generates 10 one-time recovery
 * codes (raw codes returned once, only hashes persisted).
 */
export async function enrolConfirm(
  ctx: TotpCtx,
  userId: string,
  code: string,
): Promise<EnrolConfirmResult> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? ((): Date => new Date());

  const state = await identityRepo.getUserTotpState(ctx.db, userId);
  if (!state?.totpSecretEnc) {
    throw new MfaNotEnrolledError();
  }
  // FIX 11a (P04a FIXB): see enrolStart's doc comment - re-confirming an
  // already-enrolled account is impossible without a reset flow (P04b).
  if (state.mfaEnabledAt) {
    throw new MfaAlreadyEnrolledError();
  }

  const secret = open(bytesToSealedBlob(state.totpSecretEnc), openParamsFor(ctx, userId)).toString(
    'utf8',
  );
  const result = await otpVerify({
    secret,
    token: code,
    period: TOTP_PERIOD_SEC,
    epochTolerance: ctx.totpWindow * TOTP_PERIOD_SEC,
  });
  if (!result.valid) {
    throw new InvalidTotpCodeError();
  }

  // FIX 11b (P04a FIXB): ONE transaction - delete-unused-codes,
  // set-mfa-enabled, insert-10-new-codes, atomically. A mid-loop failure
  // rolls back everything: `mfa_enabled_at` stays NULL and zero new codes
  // persist (never a partial batch alongside an enabled flag).
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await identityRepo.deleteUnusedMfaRecoveryCodes(client, userId);
    await identityRepo.setMfaEnabledAt(client, userId, now());

    const recoveryCodes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
      const raw = generateRecoveryCode();
      recoveryCodes.push(raw);

      await identityRepo.insertMfaRecoveryCode(client, {
        id: randomUUID(),
        userId,
        codeHash: sha256(raw),
      });
    }

    await client.query('COMMIT');
    return { recoveryCodes };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is what must propagate, not a rollback failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies a live TOTP code for an ALREADY-enrolled user. Replay rejection:
 * `SET NX` on a per-user-per-code Redis key with a TTL slightly wider than
 * one period - a second submission of the same code within the window finds
 * the key already present and is denied. A Redis ERROR denies too (fail
 * CLOSED, core invariant 2): it never falls back to "not replayed".
 */
export async function verify(ctx: TotpCtx, userId: string, code: string): Promise<void> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };

  const state = await identityRepo.getUserTotpState(ctx.db, userId);
  if (!state?.mfaEnabledAt || !state.totpSecretEnc) {
    throw new MfaNotEnrolledError();
  }

  const secret = open(bytesToSealedBlob(state.totpSecretEnc), openParamsFor(ctx, userId)).toString(
    'utf8',
  );
  const result = await otpVerify({
    secret,
    token: code,
    period: TOTP_PERIOD_SEC,
    epochTolerance: ctx.totpWindow * TOTP_PERIOD_SEC,
  });
  if (!result.valid) {
    throw new InvalidTotpCodeError();
  }

  const key = usedCodeRedisKey(ctx.env, userId, code);
  let claimed: 'OK' | null;
  try {
    claimed = await ctx.redis.set(key, '1', 'EX', ctx.totpUsedCodeTtlSec, 'NX');
  } catch {
    // Redis error - fail CLOSED, never treat as "not replayed" (core invariant 2).
    throw new InvalidTotpCodeError();
  }
  if (claimed === null) {
    // Key already present - this exact code was already consumed within its window.
    throw new InvalidTotpCodeError();
  }
}

/**
 * Verifies (and consumes) one recovery code. One-time use is enforced at the
 * STORAGE layer (`identity.repo.ts#claimMfaRecoveryCode`'s single conditional
 * `UPDATE`), never an in-memory check.
 */
export async function verifyRecoveryCode(
  ctx: TotpCtx,
  userId: string,
  code: string,
): Promise<void> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? ((): Date => new Date());

  const claimed = await identityRepo.claimMfaRecoveryCode(ctx.db, userId, sha256(code), now());
  if (!claimed) {
    throw new InvalidRecoveryCodeError();
  }
}
