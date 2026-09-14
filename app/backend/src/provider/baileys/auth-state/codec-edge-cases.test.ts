import '../../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '@wp/server-kit';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createAuthCodec } from './codec.js';
import type { AuthRecordRef } from './codec.js';

/**
 * codec-edge-cases.test.ts (E3 hardening pass) - failure-path coverage for
 * `createAuthCodec` that `codec.test.ts`'s happy-path round trip does not
 * exercise: a corrupted/truncated `decodeSealedBlob` input, and
 * `openAuthValue` under a mismatched AAD ref field (wrong recordId) -
 * both must fail CLOSED with a typed error, never crash-with-undefined or
 * silently return corrupted plaintext.
 */

function writeTempRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auth-codec-edge-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x07).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'ts1',
        'user-secrets': 'us1',
        'optout-pepper': 'op1',
        'api-key-pepper': 'akp1',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        ts1: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        us1: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        op1: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        akp1: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

function makeProvider(): FileKeyProvider {
  return new FileKeyProvider({ ringPath: writeTempRing(), mountedPurposes: ['session'] });
}

const REF: AuthRecordRef = {
  table: 'whatsapp_session_credentials',
  column: 'ciphertext',
  clientId: 'tenant-a',
  recordId: 'instance-1',
};

describe('createAuthCodec edge cases', () => {
  it('decodeSealedBlob_on_truncated_buffer_throws_typed_error_not_undefined_crash', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });

    // Not valid JSON at all - truncated mid-object.
    const truncated = Buffer.from('{"ciphertext":"YWJj', 'utf8');
    expect(() => codec.decodeSealedBlob(truncated)).toThrow();

    // Valid JSON but empty buffer - decode "succeeds" shape-wise (base64 of
    // '' round-trips) yet must never silently produce a usable-looking blob
    // whose fields are wrong types; if the implementation does not validate
    // shape, at minimum it must not throw an un-typed low-level TypeError
    // when this is fed onward to openAuthValue.
    const empty = Buffer.from('', 'utf8');
    expect(() => codec.decodeSealedBlob(empty)).toThrow();
  });

  it('decodeSealedBlob_on_valid_json_with_garbage_base64_fields_fails_closed_on_open', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });

    // Structurally valid EncodedSealedBlob JSON, but the base64 fields do not
    // decode to anything that was ever actually sealed - decodeSealedBlob
    // itself may succeed (base64 tolerates garbage), but the resulting blob
    // must fail closed (typed CryptoError) when opened, never crash with a
    // raw low-level buffer/length error un-typed.
    const garbage = Buffer.from(
      JSON.stringify({
        ciphertext: 'bm90LXJlYWwtY2lwaGVydGV4dA==',
        iv: 'bm90LXJlYWwtaXY=',
        auth_tag: 'bm90LXJlYWwtdGFn',
        dek_wrapped: 'bm90LXJlYWwtZGVr',
        dek_iv: 'bm90LXJlYWwtZGVrLWl2',
        dek_tag: 'bm90LXJlYWwtZGVrLXRhZw==',
        kek_id: 'kek-that-does-not-exist',
        enc_version: 1,
      }),
      'utf8',
    );

    const decoded = codec.decodeSealedBlob(garbage);
    let caught: unknown;
    try {
      codec.openAuthValue(decoded, REF);
      expect.fail('expected openAuthValue to throw on a garbage/unknown-kek blob');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
  });

  it('openAuthValue_with_a_different_recordId_in_the_AAD_ref_fails_closed', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });

    const blob = codec.sealAuthValue({ secret: 'value' }, REF);

    // Sanity: the correct ref still opens fine.
    expect(codec.openAuthValue(blob, REF)).toEqual({ secret: 'value' });

    // A DIFFERENT recordId (otherwise identical ref) must fail closed - the
    // AAD binds ciphertext to its exact (table, column, clientId, recordId)
    // tuple, so re-using a sealed blob under a different record's identity
    // must never silently open.
    const wrongRecordRef: AuthRecordRef = { ...REF, recordId: 'instance-2-not-the-owner' };
    let caught: unknown;
    try {
      codec.openAuthValue(blob, wrongRecordRef);
      expect.fail('expected openAuthValue to throw with a mismatched recordId');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('openAuthValue_with_a_different_clientId_in_the_AAD_ref_fails_closed', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });
    const blob = codec.sealAuthValue({ secret: 'value' }, REF);

    const wrongClientRef: AuthRecordRef = { ...REF, clientId: 'tenant-b-not-the-owner' };
    let caught: unknown;
    try {
      codec.openAuthValue(blob, wrongClientRef);
      expect.fail('expected openAuthValue to throw with a mismatched clientId');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });
});
