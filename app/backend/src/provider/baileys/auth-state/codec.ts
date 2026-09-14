import { BufferJSON } from 'baileys';
import { openJson, sealJson } from '@wp/server-kit/crypto';
import type { KeyProvider, SealedBlob } from '@wp/server-kit/crypto';

/**
 * THE single serialisation boundary for Baileys auth-state values (P07 Unit
 * U1, step 3). This is the ONLY file in any `src/` tree allowed to import
 * `BufferJSON` from `'baileys'` - enforced at CI by
 * `scripts/check-serialisation-boundary.ts`. Every other call site that
 * needs to seal/open auth-state material goes through `createAuthCodec`
 * below, never touches `BufferJSON`/`JSON.stringify`/`JSON.parse` itself.
 *
 * `sealAuthValue`/`openAuthValue` delegate to `@wp/server-kit`'s
 * `sealJson`/`openJson` with `purpose: 'session'` and `BufferJSON` as the
 * injected `JsonCodec` - so a `Buffer`/`Uint8Array`-aware JSON
 * (de)serialisation happens exactly once, inside server-kit, driven from
 * this one call site. `encodeSealedBlob`/`decodeSealedBlob` are a SEPARATE
 * concern: framing an already-sealed `SealedBlob`'s ciphertext fields into
 * one opaque `Buffer` for a Redis hash value - this is framing of
 * ciphertext, not auth material, so it uses plain JSON with base64 fields,
 * never `BufferJSON`.
 */

const PURPOSE = 'session' as const;

export interface AuthRecordRef {
  table: string;
  column: string;
  clientId: string;
  recordId: string;
}

export interface AuthCodec {
  sealAuthValue(value: unknown, ref: AuthRecordRef): SealedBlob;
  openAuthValue(blob: SealedBlob, ref: AuthRecordRef): unknown;
  encodeSealedBlob(blob: SealedBlob): Buffer;
  decodeSealedBlob(buf: Buffer): SealedBlob;
}

export interface CreateAuthCodecOptions {
  provider: KeyProvider;
  encVersion: number;
}

/** Base64-framed on-the-wire shape of a `SealedBlob`, for Redis hash values. */
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

function encodeSealedBlob(blob: SealedBlob): Buffer {
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

function decodeSealedBlob(buf: Buffer): SealedBlob {
  const parsed = JSON.parse(buf.toString('utf8')) as EncodedSealedBlob;
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

/**
 * Builds an `AuthCodec` bound to `opts.provider`/`opts.encVersion`.
 * Dependency-injected: nothing here reads `process.env` (only
 * `platform/config.ts` does, at a higher layer that wires this factory).
 */
export function createAuthCodec(opts: { provider: KeyProvider; encVersion: number }): AuthCodec {
  return {
    sealAuthValue(value: unknown, ref: AuthRecordRef): SealedBlob {
      return sealJson(
        value,
        {
          provider: opts.provider,
          purpose: PURPOSE,
          encVersion: opts.encVersion,
          tableName: ref.table,
          columnName: ref.column,
          clientId: ref.clientId,
          recordId: ref.recordId,
        },
        BufferJSON,
      );
    },

    openAuthValue(blob: SealedBlob, ref: AuthRecordRef): unknown {
      return openJson(
        blob,
        {
          provider: opts.provider,
          purpose: PURPOSE,
          tableName: ref.table,
          columnName: ref.column,
          clientId: ref.clientId,
          recordId: ref.recordId,
        },
        BufferJSON,
      );
    },

    encodeSealedBlob,
    decodeSealedBlob,
  };
}
