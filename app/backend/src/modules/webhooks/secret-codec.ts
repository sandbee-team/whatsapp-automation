import { seal, type KeyProvider, type SealedBlob } from '@wp/server-kit/crypto';

/**
 * secret-codec.ts (P15 U5, step 8) - the `SealedBlob` <-> `bytea` framing
 * for `webhook_endpoints.secret_enc`, plus the production seal call shape
 * (purpose `'tenant-secrets'`, table `'webhook_endpoints'`, column
 * `'secret_enc'`) - same shape as `modules/pacing/optout/registry.ts`'s
 * `sealPhoneForOptOut`/`encodeOptOutSealedBlob` pair, reused here rather
 * than imported (that module owns `opt_outs`, a different record - the
 * framing shape is duplicated on purpose, matching the existing
 * `provider/baileys/auth-state/codec.ts` precedent of a small,
 * table-local codec per record family rather than one shared generic one).
 */

interface EncodedSealedBlob {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  dek_wrapped: string;
  dek_iv: string;
  dek_tag: string;
  kek_id: string;
  enc_version: number;
}

/** Frames a `SealedBlob` into one opaque `Buffer` for `webhook_endpoints.secret_enc`. */
export function sealedBlobToBytes(blob: SealedBlob): Buffer {
  const encoded: EncodedSealedBlob = {
    ciphertext: blob.ciphertext.toString('base64'),
    iv: blob.iv.toString('base64'),
    auth_tag: blob.auth_tag.toString('base64'),
    dek_wrapped: blob.dek_wrapped.toString('base64'),
    dek_iv: blob.dek_iv.toString('base64'),
    dek_tag: blob.dek_tag.toString('base64'),
    kek_id: blob.kek_id,
    enc_version: blob.enc_version,
  };
  return Buffer.from(JSON.stringify(encoded), 'utf8');
}

export function bytesToSealedBlob(bytes: Buffer): SealedBlob {
  const parsed = JSON.parse(bytes.toString('utf8')) as EncodedSealedBlob;
  return {
    ciphertext: Buffer.from(parsed.ciphertext, 'base64'),
    iv: Buffer.from(parsed.iv, 'base64'),
    auth_tag: Buffer.from(parsed.auth_tag, 'base64'),
    dek_wrapped: Buffer.from(parsed.dek_wrapped, 'base64'),
    dek_iv: Buffer.from(parsed.dek_iv, 'base64'),
    dek_tag: Buffer.from(parsed.dek_tag, 'base64'),
    kek_id: parsed.kek_id,
    enc_version: parsed.enc_version,
  };
}

export interface SealWebhookSecretInput {
  clientId: string;
  endpointId: string;
  secret: string;
  encVersion: number;
}

/** The production seal call shape for `webhook_endpoints.secret_enc`. Returns the FRAMED buffer ready to store. */
export function sealWebhookSecret(provider: KeyProvider, input: SealWebhookSecretInput): Buffer {
  const blob = seal(Buffer.from(input.secret, 'utf8'), {
    provider,
    purpose: 'tenant-secrets',
    encVersion: input.encVersion,
    tableName: 'webhook_endpoints',
    columnName: 'secret_enc',
    clientId: input.clientId,
    recordId: input.endpointId,
  });
  return sealedBlobToBytes(blob);
}
