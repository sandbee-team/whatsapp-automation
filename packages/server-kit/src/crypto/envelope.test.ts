import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';
import { open, seal } from './envelope.js';
import type { OpenParams, SealParams } from './envelope.js';

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-envelope-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

// Shared setup helpers, kept at the top on purpose: a later test in this
// same describe block reuses these rather than duplicating fixture wiring.

/** A `FileKeyProvider` over the fixture ring, mounted for the given purposes. */
function makeProvider(mountedPurposes: readonly ('session' | 'tenant-secrets' | 'user-secrets')[]) {
  return new FileKeyProvider({ ringPath: FIXTURE_RING_PATH, mountedPurposes });
}

/** Baseline seal params for a record belonging to `tenant-a`/`record-1`. */
function baseSealParams(overrides: Partial<SealParams> = {}): SealParams {
  return {
    provider: makeProvider(['session']),
    purpose: 'session',
    encVersion: 1,
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'record-1',
    ...overrides,
  };
}

/** Baseline open params mirroring `baseSealParams` (minus `encVersion`). */
function baseOpenParams(overrides: Partial<OpenParams> = {}): OpenParams {
  return {
    provider: makeProvider(['session']),
    purpose: 'session',
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'record-1',
    ...overrides,
  };
}

const PLAINTEXT = Buffer.from('super secret session material', 'utf8');

describe('envelope seal/open', () => {
  it('seals_and_opens_a_round_trip', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const opened = open(blob, baseOpenParams());
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });

  it('a_blob_sealed_at_enc_version_1_still_opens_after_the_constant_moves_to_2', () => {
    const oldBlob = seal(PLAINTEXT, baseSealParams({ encVersion: 1 }));
    expect(oldBlob.enc_version).toBe(1);

    // Simulate the app-wide `encVersion` constant moving to 2 for new writes.
    const newBlob = seal(PLAINTEXT, baseSealParams({ encVersion: 2 }));
    expect(newBlob.enc_version).toBe(2);

    // The old blob still opens: `open()` derives its AADs from the blob's
    // OWN stored `enc_version` (1), never from "2".
    const openedOld = open(oldBlob, baseOpenParams());
    expect(openedOld.equals(PLAINTEXT)).toBe(true);

    const openedNew = open(newBlob, baseOpenParams());
    expect(openedNew.equals(PLAINTEXT)).toBe(true);
  });

  it('a_blob_moved_to_another_tenant_fails_to_open', () => {
    const blob = seal(PLAINTEXT, baseSealParams({ clientId: 'tenant-a' }));

    let caught: unknown;
    try {
      open(blob, baseOpenParams({ clientId: 'tenant-b' }));
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
    expect(caught).not.toBe(undefined);
  });

  it('a_blob_moved_to_another_record_fails_to_open', () => {
    const blob = seal(PLAINTEXT, baseSealParams({ recordId: 'record-1' }));

    let caught: unknown;
    try {
      open(blob, baseOpenParams({ recordId: 'record-2' }));
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('a_tampered_ciphertext_byte_fails_the_auth_tag', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const tampered = { ...blob, ciphertext: Buffer.from(blob.ciphertext) };
    tampered.ciphertext.writeUInt8(tampered.ciphertext.readUInt8(0) ^ 0x01, 0);

    let caught: unknown;
    try {
      open(tampered, baseOpenParams());
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('a_tampered_dek_wrapped_byte_fails_the_auth_tag', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const tampered = { ...blob, dek_wrapped: Buffer.from(blob.dek_wrapped) };
    tampered.dek_wrapped.writeUInt8(tampered.dek_wrapped.readUInt8(0) ^ 0x01, 0);

    let caught: unknown;
    try {
      open(tampered, baseOpenParams());
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('every_seal_uses_a_fresh_iv', () => {
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    const iterations = 1000;

    for (let i = 0; i < iterations; i += 1) {
      const blob = seal(PLAINTEXT, baseSealParams());
      ivs.add(blob.iv.toString('hex'));
      ciphertexts.add(blob.ciphertext.toString('hex'));
    }

    expect(ivs.size).toBe(iterations);
    expect(ciphertexts.size).toBe(iterations);
  });

  it('open_with_the_wrong_purposes_provider_fails', () => {
    const blob = seal(PLAINTEXT, baseSealParams({ purpose: 'session' }));

    let caught: unknown;
    try {
      // `tenant-secrets` is mounted, but the blob's kek_id (k2) belongs to
      // `session` - `provider.get` throws `CRYPTO_PURPOSE_MISMATCH`
      // internally, but `open()` flattens every failure to
      // `CRYPTO_DECRYPT_FAILED` (never leaks the provider's internal code).
      open(
        blob,
        baseOpenParams({
          provider: makeProvider(['session', 'tenant-secrets']),
          purpose: 'tenant-secrets',
        }),
      );
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('a_blobs_stored_kek_id_pointing_at_a_retired_key_still_opens', () => {
    // Seal under active k1, then rotate (k1 retired, k9 active) - must still
    // open: open() uses provider.get(kek_id, purpose), never getActive().
    // `active` is a `z.record` over the full enum, so every non-`session`
    // purpose below carries one fixed, shared entry regardless of which
    // `session` kekId is active - `nonSessionActive`/`nonSessionKeys` factor
    // that shared shape out so this test only varies what a rotation
    // actually changes (which `session` key is active/retired).
    const k1Material = Buffer.alloc(32, 0x01).toString('base64');
    const k9Material = Buffer.alloc(32, 0x09).toString('base64');
    const tsMaterial = Buffer.alloc(32, 0x03).toString('base64');
    const usMaterial = Buffer.alloc(32, 0x04).toString('base64');
    const nonSessionKeys = {
      ts1: {
        purpose: 'tenant-secrets',
        material: tsMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      us1: {
        purpose: 'user-secrets',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      op1: {
        purpose: 'optout-pepper',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      akp1: {
        purpose: 'api-key-pepper',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const nonSessionActive = {
      'tenant-secrets': 'ts1',
      'user-secrets': 'us1',
      'optout-pepper': 'op1',
      'api-key-pepper': 'akp1',
    };

    const sealRingPath = writeTempRing({
      version: 1,
      active: { session: 'k1', ...nonSessionActive },
      keys: {
        k1: { purpose: 'session', material: k1Material, created_at: '2026-01-01T00:00:00.000Z' },
        ...nonSessionKeys,
      },
    });
    const sealProvider = new FileKeyProvider({
      ringPath: sealRingPath,
      mountedPurposes: ['session'],
    });

    const blob = seal(PLAINTEXT, baseSealParams({ provider: sealProvider }));
    expect(blob.kek_id).toBe('k1');

    const openRingPath = writeTempRing({
      version: 1,
      active: { session: 'k9', ...nonSessionActive },
      keys: {
        k1: {
          purpose: 'session',
          material: k1Material,
          created_at: '2026-01-01T00:00:00.000Z',
          retired: true,
        },
        k9: { purpose: 'session', material: k9Material, created_at: '2026-02-01T00:00:00.000Z' },
        ...nonSessionKeys,
      },
    });
    const openProvider = new FileKeyProvider({
      ringPath: openRingPath,
      mountedPurposes: ['session'],
    });

    const opened = open(blob, baseOpenParams({ provider: openProvider }));
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });

  it('seal_wraps_provider_getActive_failures_as_CRYPTO_ENCRYPT_FAILED', () => {
    let caught: unknown;
    try {
      // `session` isn't mounted on this provider, so `getActive` throws
      // `CRYPTO_KEY_UNAVAILABLE` internally - `seal()` flattens that (and
      // every other seal-side failure) to `CRYPTO_ENCRYPT_FAILED`.
      seal(PLAINTEXT, baseSealParams({ provider: makeProvider(['tenant-secrets']) }));
      throw new Error('expected seal to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_ENCRYPT_FAILED');
  });
});
