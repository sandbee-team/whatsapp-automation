import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';
import { open, seal } from './envelope.js';
import type { OpenParams, SealParams } from './envelope.js';

/**
 * Split out of `envelope.test.ts` (E3 edge-case pass, P01) purely to stay
 * under the `max-lines` lint limit - same fixtures/helpers, same describe
 * subject (`seal`/`open`), just the empty-identity guard, large/empty
 * payload, individual-field-tamper, wrong-length, franken-blob, and
 * stranger-provider cases.
 */

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-envelope-edge-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

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

describe('envelope seal/open - edge cases', () => {
  it('seal_rejects_an_empty_clientId_rather_than_weaken_the_tenant_binding', () => {
    // An empty clientId would still produce a "validly" sealed blob whose
    // recordAad carries a zero-length clientId field - i.e. no real tenant
    // binding at all. Reject at seal time instead of silently sealing.
    let caught: unknown;
    try {
      seal(PLAINTEXT, baseSealParams({ clientId: '' }));
      throw new Error('expected seal to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_ENCRYPT_FAILED');
  });

  it('seal_rejects_an_empty_recordId', () => {
    let caught: unknown;
    try {
      seal(PLAINTEXT, baseSealParams({ recordId: '' }));
      throw new Error('expected seal to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_ENCRYPT_FAILED');
  });

  it('open_rejects_an_empty_clientId_or_recordId_the_same_way', () => {
    const blob = seal(PLAINTEXT, baseSealParams());

    let caughtClient: unknown;
    try {
      open(blob, baseOpenParams({ clientId: '' }));
      throw new Error('expected open to throw');
    } catch (err) {
      caughtClient = err;
    }
    expect(caughtClient).toBeInstanceOf(CryptoError);
    expect((caughtClient as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');

    let caughtRecord: unknown;
    try {
      open(blob, baseOpenParams({ recordId: '' }));
      throw new Error('expected open to throw');
    } catch (err) {
      caughtRecord = err;
    }
    expect(caughtRecord).toBeInstanceOf(CryptoError);
    expect((caughtRecord as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('seal_produces_a_valid_blob_for_an_empty_plaintext_Buffer', () => {
    const blob = seal(Buffer.alloc(0), baseSealParams());
    expect(blob.ciphertext.length).toBe(0);
    const opened = open(blob, baseOpenParams());
    expect(opened.length).toBe(0);
  });

  it('seals_and_opens_a_large_5MB_plaintext', () => {
    const large = Buffer.alloc(5 * 1024 * 1024);
    large.fill(0xab);
    // Make it non-uniform so a truncation bug wouldn't accidentally pass.
    large.write('end-marker', large.length - 20, 'utf8');

    const blob = seal(large, baseSealParams());
    const opened = open(blob, baseOpenParams());
    expect(opened.length).toBe(large.length);
    expect(opened.equals(large)).toBe(true);
  });

  it.each(['iv', 'auth_tag', 'dek_iv', 'dek_tag'] as const)(
    'a_tampered_%s_byte_fails_the_auth_tag',
    (field) => {
      const blob = seal(PLAINTEXT, baseSealParams());
      const tampered = { ...blob, [field]: Buffer.from(blob[field]) };
      const buf = tampered[field] as Buffer;
      buf.writeUInt8(buf.readUInt8(0) ^ 0x01, 0);

      let caught: unknown;
      try {
        open(tampered, baseOpenParams());
        throw new Error('expected open to throw');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CryptoError);
      expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
    },
  );

  it('a_wrong_length_iv_in_a_forged_blob_fails_closed_rather_than_throwing_unhandled', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const forged = { ...blob, iv: Buffer.alloc(4, 0x00) };

    let caught: unknown;
    try {
      open(forged, baseOpenParams());
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('a_wrong_length_dek_iv_in_a_forged_blob_fails_closed', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const forged = { ...blob, dek_iv: Buffer.alloc(1, 0x00) };

    let caught: unknown;
    try {
      open(forged, baseOpenParams());
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('a_blob_field_swap_between_two_validly_sealed_blobs_fails_to_open', () => {
    const plaintextA = Buffer.from('plaintext A', 'utf8');
    const plaintextB = Buffer.from('plaintext B', 'utf8');
    const blobA = seal(plaintextA, baseSealParams({ recordId: 'record-a' }));
    const blobB = seal(plaintextB, baseSealParams({ recordId: 'record-b' }));

    // Franken-blob: B's record ciphertext/iv/tag with A's wrapped-DEK layer.
    const franken = {
      ...blobB,
      dek_wrapped: blobA.dek_wrapped,
      dek_iv: blobA.dek_iv,
      dek_tag: blobA.dek_tag,
      kek_id: blobA.kek_id,
    };

    let caught: unknown;
    try {
      open(franken, baseOpenParams({ recordId: 'record-b' }));
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('opening_with_a_provider_that_never_mounted_the_blobs_kek_id_fails_closed', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    expect(blob.kek_id).toBe('k2');

    // A provider mounted for the right purpose but built from a ring that
    // simply doesn't contain k2 at all (not just "not mounted").
    const k9Material = Buffer.alloc(32, 0x09).toString('base64');
    const tsMaterial = Buffer.alloc(32, 0x03).toString('base64');
    const usMaterial = Buffer.alloc(32, 0x04).toString('base64');
    const strangerRingPath = writeTempRing({
      version: 1,
      active: {
        session: 'k9',
        'tenant-secrets': 'ts1',
        'user-secrets': 'us1',
        'optout-pepper': 'op1',
        'api-key-pepper': 'akp1',
      },
      keys: {
        k9: {
          purpose: 'session',
          material: k9Material,
          created_at: '2026-01-01T00:00:00.000Z',
        },
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
      },
    });
    const strangerProvider = new FileKeyProvider({
      ringPath: strangerRingPath,
      mountedPurposes: ['session'],
    });

    let caught: unknown;
    try {
      open(blob, baseOpenParams({ provider: strangerProvider }));
      throw new Error('expected open to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });
});
