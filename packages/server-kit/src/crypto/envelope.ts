import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from '../errors/app-error.js';
import { dekWrapAad, recordAad } from './aad.js';
import type { KeyProvider } from './key-provider.js';
import type { KekPurpose } from './purposes.js';
import type { SealedBlob } from './sealed-blob.js';

const ALGORITHM = 'aes-256-gcm';
const DEK_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;

/**
 * `recordAad` binds tenant/record identity by concatenating length-prefixed
 * `clientId`/`recordId` bytes - but an EMPTY string is a valid, non-throwing
 * input to that encoding (it just contributes a zero-length field). A blob
 * sealed with `clientId: ''` would therefore "validly" open again under any
 * other empty `clientId`, which is no tenant binding at all. Reject empty
 * identity fields at the boundary rather than let that ambiguity into a
 * sealed blob.
 */
function assertNonEmptyIdentity(clientId: string, recordId: string): void {
  if (clientId.length === 0 || recordId.length === 0) {
    throw new Error('clientId and recordId must be non-empty - empty values weaken tenant binding');
  }
}

export type SealParams = {
  provider: KeyProvider;
  purpose: KekPurpose;
  /**
   * Dependency-injected, not read from config here - callers wire this from
   * config at boot (a later phase). Keeping `envelope.ts` free of a config
   * import is what lets `open()` below trust each blob's own stored
   * `enc_version` instead of whatever the current constant says.
   */
  encVersion: number;
  tableName: string;
  columnName: string;
  clientId: string;
  recordId: string;
};

export type OpenParams = {
  provider: KeyProvider;
  purpose: KekPurpose;
  tableName: string;
  columnName: string;
  clientId: string;
  recordId: string;
};

/**
 * Envelope-seals `plaintext` (data-security design §4.2): a fresh random
 * 32-byte DEK encrypts the record under AES-256-GCM with a fresh random
 * 12-byte IV and `recordAad`; the DEK itself is then wrapped (encrypted)
 * under the purpose's active KEK with its own fresh random 12-byte IV and
 * `dekWrapAad`. Both AAD formulas live in `aad.ts` only. The DEK buffer is
 * zeroed (`fill(0)`) as soon as both encrypt operations are done.
 */
export function seal(plaintext: Buffer, params: SealParams): SealedBlob {
  const dek = randomBytes(DEK_BYTE_LENGTH);
  try {
    assertNonEmptyIdentity(params.clientId, params.recordId);
    const kek = params.provider.getActive(params.purpose);

    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dek, iv);
    cipher.setAAD(
      recordAad({
        encVersion: params.encVersion,
        tableName: params.tableName,
        columnName: params.columnName,
        clientId: params.clientId,
        recordId: params.recordId,
      }),
    );
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const dekIv = randomBytes(IV_BYTE_LENGTH);
    const dekCipher = createCipheriv(ALGORITHM, kek.material, dekIv);
    dekCipher.setAAD(
      dekWrapAad({
        encVersion: params.encVersion,
        kekId: kek.kekId,
        purpose: params.purpose,
      }),
    );
    const dekWrapped = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekTag = dekCipher.getAuthTag();

    return {
      ciphertext,
      iv,
      auth_tag: authTag,
      dek_wrapped: dekWrapped,
      dek_iv: dekIv,
      dek_tag: dekTag,
      kek_id: kek.kekId,
      enc_version: params.encVersion,
    };
  } catch {
    // Every seal-side failure - including a provider error such as
    // `CRYPTO_KEY_UNAVAILABLE` - flattens to `CRYPTO_ENCRYPT_FAILED`. Callers
    // of `seal()` get exactly one failure mode; the specific cause never
    // leaks into the thrown error's message.
    throw new CryptoError('CRYPTO_ENCRYPT_FAILED', 'unknown');
  } finally {
    dek.fill(0);
  }
}

/**
 * Opens a `SealedBlob` (data-security design §4.2). Both AAD values are
 * derived from the blob's OWN stored `enc_version`/`kek_id` - never from the
 * current `encVersion` constant or the provider's current active key. This
 * is deliberate: deriving from "current" values would make every
 * already-sealed row undecryptable the instant either constant moves
 * (phase risk note - a fleet-wide re-QR with no rollback). Uses
 * `provider.get(blob.kek_id, purpose)` (not `getActive`) so a retired KEK
 * still opens old ciphertext.
 *
 * Any failure - unwrap auth failure, record auth failure, wrong length,
 * unknown/mismatched key - throws `CryptoError('CRYPTO_DECRYPT_FAILED',
 * blob.kek_id)` (message stays exactly `<code>:<kekId>` - `CryptoError`
 * carries no `cause`/underlying-error text). Never returns partial
 * plaintext.
 */
export function open(blob: SealedBlob, params: OpenParams): Buffer {
  let dek: Buffer | undefined;
  try {
    assertNonEmptyIdentity(params.clientId, params.recordId);
    const kek = params.provider.get(blob.kek_id, params.purpose);

    const dekCipher = createDecipheriv(ALGORITHM, kek.material, blob.dek_iv);
    dekCipher.setAuthTag(blob.dek_tag);
    dekCipher.setAAD(
      dekWrapAad({
        encVersion: blob.enc_version,
        kekId: blob.kek_id,
        purpose: params.purpose,
      }),
    );
    dek = Buffer.concat([dekCipher.update(blob.dek_wrapped), dekCipher.final()]);

    const cipher = createDecipheriv(ALGORITHM, dek, blob.iv);
    cipher.setAuthTag(blob.auth_tag);
    cipher.setAAD(
      recordAad({
        encVersion: blob.enc_version,
        tableName: params.tableName,
        columnName: params.columnName,
        clientId: params.clientId,
        recordId: params.recordId,
      }),
    );
    return Buffer.concat([cipher.update(blob.ciphertext), cipher.final()]);
  } catch {
    // Every open-side failure - unwrap auth failure, record auth failure,
    // wrong length, unknown/mismatched key - flattens to the same
    // `CRYPTO_DECRYPT_FAILED`. Callers of `open()` get exactly one failure
    // mode; the specific cause never leaks into the thrown error's message.
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id);
  } finally {
    dek?.fill(0);
  }
}
