import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from '../errors/app-error.js';
import { dekWrapAad } from './aad.js';
import type { KeyProvider } from './key-provider.js';
import type { KekPurpose } from './purposes.js';
import type { SealedBlob } from './sealed-blob.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTE_LENGTH = 12;

export type RewrapDekOptions = {
  provider: KeyProvider;
  purpose: KekPurpose;
};

/**
 * KEK rotation (data-security design §4.2/§4.5, blueprint's rotation
 * runbook): unwraps `blob`'s DEK under its current (possibly `retired`) KEK
 * and rewraps it under `toKekId`, leaving the record layer -
 * `ciphertext`/`iv`/`auth_tag`/`enc_version` - byte-identical. Only
 * `dek_wrapped`/`dek_iv`/`dek_tag`/`kek_id` change. This is what makes
 * rotation cheap: it never re-touches the (potentially large) record
 * ciphertext, only the small wrapped-DEK envelope.
 *
 * Both AAD values are derived from `blob`'s OWN stored `enc_version` (never
 * a "current" constant - see `envelope.ts`'s `open()` doc comment for why),
 * `purpose` (the caller's, since a `SealedBlob` doesn't carry its own
 * purpose), and the relevant `kek_id` (the unwrap side uses `blob.kek_id`,
 * the wrap side uses `toKekId`).
 *
 * `provider.get(blob.kek_id, purpose)` is used for the unwrap side (not
 * `getActive`) - exactly the rotation scenario: the source KEK is expected
 * to already be `retired`. `toKekId` is REJECTED if it resolves to a
 * `retired` key - a retired key must never seal, including as a rotation
 * target - throwing `CryptoError('CRYPTO_KEY_UNAVAILABLE', toKekId)`
 * directly (not flattened, so callers can tell "target unusable" apart from
 * a genuine crypto failure).
 *
 * Every other failure flattens the same way `envelope.ts` does: an unwrap
 * failure (bad key, tampered `dek_wrapped`, wrong purpose) throws
 * `CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id)`; a wrap failure throws
 * `CryptoError('CRYPTO_ENCRYPT_FAILED', toKekId)`. The plaintext DEK buffer
 * is zeroed (`fill(0)`) before returning or throwing.
 */
export function rewrapDek(blob: SealedBlob, toKekId: string, opts: RewrapDekOptions): SealedBlob {
  let dek: Buffer | undefined;
  try {
    try {
      const fromKek = opts.provider.get(blob.kek_id, opts.purpose);

      const unwrapCipher = createDecipheriv(ALGORITHM, fromKek.material, blob.dek_iv);
      unwrapCipher.setAuthTag(blob.dek_tag);
      unwrapCipher.setAAD(
        dekWrapAad({
          encVersion: blob.enc_version,
          kekId: blob.kek_id,
          purpose: opts.purpose,
        }),
      );
      dek = Buffer.concat([unwrapCipher.update(blob.dek_wrapped), unwrapCipher.final()]);
    } catch {
      // Every unwrap-side failure - unknown/mismatched key, tampered
      // `dek_wrapped`/`dek_tag`, wrong purpose - flattens to the same
      // `CRYPTO_DECRYPT_FAILED`, mirroring `envelope.ts`'s `open()`.
      throw new CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id);
    }

    const toKek = opts.provider.get(toKekId, opts.purpose);
    if (toKek.retired) {
      throw new CryptoError('CRYPTO_KEY_UNAVAILABLE', toKekId);
    }

    try {
      const dekIv = randomBytes(IV_BYTE_LENGTH);
      const wrapCipher = createCipheriv(ALGORITHM, toKek.material, dekIv);
      wrapCipher.setAAD(
        dekWrapAad({
          encVersion: blob.enc_version,
          kekId: toKekId,
          purpose: opts.purpose,
        }),
      );
      const dekWrapped = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
      const dekTag = wrapCipher.getAuthTag();

      return {
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        auth_tag: blob.auth_tag,
        dek_wrapped: dekWrapped,
        dek_iv: dekIv,
        dek_tag: dekTag,
        kek_id: toKekId,
        enc_version: blob.enc_version,
      };
    } catch {
      // Every wrap-side failure flattens to `CRYPTO_ENCRYPT_FAILED`,
      // mirroring `envelope.ts`'s `seal()`.
      throw new CryptoError('CRYPTO_ENCRYPT_FAILED', toKekId);
    }
  } finally {
    dek?.fill(0);
  }
}
