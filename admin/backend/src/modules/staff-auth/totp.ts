import { FileKeyProvider, open, type SealedBlob } from '@wp/server-kit/crypto';
import { verify as otpVerify } from 'otplib';

/**
 * modules/staff-auth/totp.ts (P28 Unit U4, step 6) - staff TOTP
 * verification. TOTP IS MANDATORY for staff: there is no password-only
 * login path at all, and an account with `mfa_enabled_at IS NULL` is
 * refused with `MFA_ENROLL_REQUIRED` rather than being let in "just this
 * once" (a staff account without a second factor is a cross-tenant read of
 * the whole platform behind one password).
 *
 * The secret is NEVER stored in plaintext: `staff_users.mfa_totp_secret_enc`
 * holds a `SealedBlob` (envelope crypto, purpose `user-secrets`) serialised
 * as `bytea`, opened here. The codec and key-provider shape mirror
 * app-backend's `modules/identity/totp-secret.ts` exactly - a cross-project
 * import of that file is forbidden (dependency-cruiser
 * `no-cross-project-admin-to-app`), so this is a deliberate per-project
 * copy of the SERIALISATION FORMAT, which is a storage contract and must
 * stay byte-compatible: `scripts/ops/create-staff-user.ts` writes rows in
 * this exact shape.
 *
 * REPLAY REJECTION is in-memory (`UsedTotpCodes`), not Redis - admin-api has
 * no Redis dependency, and it is a SINGLE process (see `lockout.ts`'s honest
 * limitation note, which applies identically here). A code is single-use
 * within its own step window; the window is short enough that a
 * process restart losing the set is not a meaningful weakening, because the
 * code itself expires anyway.
 */

const STAFF_TOTP_TABLE = 'staff_users';
const STAFF_TOTP_COLUMN = 'mfa_totp_secret_enc';
/**
 * `recordAad` requires a non-empty `clientId` even though `staff_users`
 * carries no `client_id` (staff belong to WP, not to a tenant). This fixed,
 * non-secret constant fills that slot; the binding that actually matters -
 * preventing a blob moved to another row from opening - comes from
 * `recordId` (the staff id), which IS unique per row.
 */
const STAFF_IDENTITY_CLIENT_ID = 'staff_users';
export const TOTP_PERIOD_SEC = 30;

export class StaffTotpRequiredError extends Error {
  readonly code = 'MFA_ENROLL_REQUIRED';
  constructor() {
    super('TOTP enrolment is required for this staff account.');
    this.name = 'StaffTotpRequiredError';
  }
}

export class StaffInvalidTotpError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Invalid or already-used TOTP code.');
    this.name = 'StaffInvalidTotpError';
  }
}

export interface StaffTotpParams {
  keyRingPath: string;
  encVersion: number;
}

export function staffSealParams(params: StaffTotpParams, staffId: string) {
  return {
    provider: new FileKeyProvider({
      ringPath: params.keyRingPath,
      mountedPurposes: ['user-secrets'],
    }),
    purpose: 'user-secrets' as const,
    encVersion: params.encVersion,
    tableName: STAFF_TOTP_TABLE,
    columnName: STAFF_TOTP_COLUMN,
    clientId: STAFF_IDENTITY_CLIENT_ID,
    recordId: staffId,
  };
}

/** The `bytea` <-> `SealedBlob` codec - ONE `JSON.stringify` out, ONE `JSON.parse` in (storage contract, see module header). */
export function sealedBlobToBytes(blob: SealedBlob): Buffer {
  return Buffer.from(
    JSON.stringify({
      ciphertext: blob.ciphertext.toString('base64'),
      iv: blob.iv.toString('base64'),
      auth_tag: blob.auth_tag.toString('base64'),
      dek_wrapped: blob.dek_wrapped.toString('base64'),
      dek_iv: blob.dek_iv.toString('base64'),
      dek_tag: blob.dek_tag.toString('base64'),
      kek_id: blob.kek_id,
      enc_version: blob.enc_version,
    }),
    'utf8',
  );
}

export function bytesToSealedBlob(bytes: Buffer): SealedBlob {
  const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, string | number>;
  return {
    ciphertext: Buffer.from(parsed.ciphertext as string, 'base64'),
    iv: Buffer.from(parsed.iv as string, 'base64'),
    auth_tag: Buffer.from(parsed.auth_tag as string, 'base64'),
    dek_wrapped: Buffer.from(parsed.dek_wrapped as string, 'base64'),
    dek_iv: Buffer.from(parsed.dek_iv as string, 'base64'),
    dek_tag: Buffer.from(parsed.dek_tag as string, 'base64'),
    kek_id: parsed.kek_id as string,
    enc_version: parsed.enc_version as number,
  };
}

/** In-memory single-use marker set, keyed `staffId:code` (see module header for why this is not Redis). */
export class UsedTotpCodes {
  private readonly used = new Map<string, number>();

  /** True when this exact code has NOT been used for this staff member inside its own window; marks it used. */
  claim(staffId: string, code: string, now: Date, windowSeconds: number): boolean {
    const cutoff = now.getTime() - windowSeconds * 1000;
    for (const [key, at] of this.used) {
      if (at <= cutoff) this.used.delete(key);
    }
    const key = `${staffId}:${code}`;
    if (this.used.has(key)) return false;
    this.used.set(key, now.getTime());
    return true;
  }
}

export interface VerifyStaffTotpInput {
  staffId: string;
  code: string;
  secretEnc: Buffer | null;
  mfaEnabledAt: Date | null;
  params: StaffTotpParams;
  /** +/- this many 30-second periods of clock drift tolerated. */
  window: number;
  now: Date;
  usedCodes: UsedTotpCodes;
}

/**
 * Verifies one live TOTP code against the sealed secret. Throws
 * `StaffTotpRequiredError` when the account never completed enrolment, and
 * `StaffInvalidTotpError` for a wrong code, an unopenable secret, OR a
 * replayed code - the three are deliberately indistinguishable to the
 * caller, so a failed login never reveals which factor was wrong.
 */
export async function verifyStaffTotp(input: VerifyStaffTotpInput): Promise<void> {
  if (!input.mfaEnabledAt || !input.secretEnc) {
    throw new StaffTotpRequiredError();
  }

  let secret: string;
  try {
    secret = open(
      bytesToSealedBlob(input.secretEnc),
      staffSealParams(input.params, input.staffId),
    ).toString('utf8');
  } catch {
    // An unopenable secret is an operational fault (wrong key ring, rotated
    // KEK) - but from the caller's side it must look exactly like a wrong
    // code, never a hint that this account exists and is misconfigured.
    throw new StaffInvalidTotpError();
  }

  const result = await otpVerify({
    secret,
    token: input.code,
    period: TOTP_PERIOD_SEC,
    epochTolerance: input.window * TOTP_PERIOD_SEC,
  });
  if (!result.valid) {
    throw new StaffInvalidTotpError();
  }

  // Replay: a valid code is accepted exactly once per staff member within
  // its own window (fail CLOSED - a second submission is refused).
  const windowSeconds = TOTP_PERIOD_SEC * (input.window * 2 + 1) + 5;
  if (!input.usedCodes.claim(input.staffId, input.code, input.now, windowSeconds)) {
    throw new StaffInvalidTotpError();
  }
}
