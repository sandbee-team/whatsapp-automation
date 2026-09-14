import { createHash, randomBytes } from 'node:crypto';
import { FileKeyProvider, type SealedBlob } from '@wp/server-kit/crypto';

/**
 * totp-secret.ts (P04a Unit UA5b, split out of totp.service.ts for
 * max-lines) - the `SealedBlob` <-> `bytea` codec plus recovery-code
 * generation/hashing. Pure code motion: no behavior change from the
 * original totp.service.ts.
 */

/**
 * `seal`/`open`'s AAD (`recordAad`) requires a non-empty `clientId` field
 * (`envelope.ts`'s `assertNonEmptyIdentity`) even though `users` itself
 * carries no `client_id` column (identity is global). This fixed, non-secret
 * constant fills that slot for every user-keyed TOTP secret; the binding
 * that actually matters here - preventing a blob moved to another row from
 * opening - comes from `recordId` (the userId), which IS unique per row, not
 * from this constant.
 */
const GLOBAL_IDENTITY_CLIENT_ID = 'users';
const TOTP_SECRET_TABLE = 'users';
const TOTP_SECRET_COLUMN = 'mfa_totp_secret_enc';
const TOTP_SECRET_ENC_VERSION = 1;
// Crockford-style base32 alphabet (no padding, no ambiguous 0/O/1/I/L) - the
// codes are shown to the user once, so avoiding visually-confusable
// characters matters more here than RFC 4648 compliance.
const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_LENGTH = 10;

export function makeKeyProvider(ctx: { keyRingPath: string }): FileKeyProvider {
  return new FileKeyProvider({ ringPath: ctx.keyRingPath, mountedPurposes: ['user-secrets'] });
}

export function sealParamsFor(ctx: { keyRingPath: string }, userId: string) {
  return {
    provider: makeKeyProvider(ctx),
    purpose: 'user-secrets' as const,
    encVersion: TOTP_SECRET_ENC_VERSION,
    tableName: TOTP_SECRET_TABLE,
    columnName: TOTP_SECRET_COLUMN,
    clientId: GLOBAL_IDENTITY_CLIENT_ID,
    recordId: userId,
  };
}

export function openParamsFor(ctx: { keyRingPath: string }, userId: string) {
  return {
    provider: makeKeyProvider(ctx),
    purpose: 'user-secrets' as const,
    tableName: TOTP_SECRET_TABLE,
    columnName: TOTP_SECRET_COLUMN,
    clientId: GLOBAL_IDENTITY_CLIENT_ID,
    recordId: userId,
  };
}

/**
 * The ONE (`SealedBlob` <-> `bytea`) serialisation boundary this module
 * needs: `users.mfa_totp_secret_enc` is a single `bytea` column, but a
 * `SealedBlob` carries several typed fields. `@wp/server-kit`'s own
 * `sealJson`/`openJson` boundary (same "exactly one JSON.stringify/parse"
 * shape - see `packages/server-kit/test/auth-state-round-trip.test.ts`)
 * seals a *plaintext payload* via an injected Buffer-aware codec
 * (Baileys' `BufferJSON`, usable only from that package's own test tree);
 * there is no equivalent for serialising the `SealedBlob` STRUCT itself, so
 * this is a small local, generic (base64, not Baileys-specific) codec that
 * fills the same role for this module's Buffer fields - one `JSON.stringify`
 * in `sealedBlobToBytes`, one `JSON.parse` in `bytesToSealedBlob`, never a
 * second parse either direction.
 */
export function sealedBlobToBytes(blob: SealedBlob): Buffer {
  const json = JSON.stringify({
    ciphertext: blob.ciphertext.toString('base64'),
    iv: blob.iv.toString('base64'),
    auth_tag: blob.auth_tag.toString('base64'),
    dek_wrapped: blob.dek_wrapped.toString('base64'),
    dek_iv: blob.dek_iv.toString('base64'),
    dek_tag: blob.dek_tag.toString('base64'),
    kek_id: blob.kek_id,
    enc_version: blob.enc_version,
  });
  return Buffer.from(json, 'utf8');
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

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/** A 10-char Crockford-base32 recovery code, e.g. `A7K9-QRZ2...` shape without the dash. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    out += RECOVERY_CODE_ALPHABET[bytes[i]! % RECOVERY_CODE_ALPHABET.length];
  }
  return out;
}
