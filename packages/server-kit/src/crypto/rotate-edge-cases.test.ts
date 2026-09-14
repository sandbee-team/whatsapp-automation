import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';
import { open, seal } from './envelope.js';
import type { OpenParams, SealParams } from './envelope.js';
import { rewrapDek } from './rotate.js';

/**
 * Split out of `rotate.test.ts` (E3 edge-case pass, P01) to stay under the
 * `max-lines` lint limit - same fixtures/helpers, same describe subject
 * (`rewrapDek`), just the same-kekId, tampered-blob, and double-rotation
 * cases.
 */

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-rotate-edge-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

/** A `FileKeyProvider` over the fixture ring, mounted for the given purposes. */
function makeFixtureProvider(
  mountedPurposes: readonly ('session' | 'tenant-secrets' | 'user-secrets')[],
) {
  return new FileKeyProvider({ ringPath: FIXTURE_RING_PATH, mountedPurposes });
}

/** Baseline seal params for a record belonging to `tenant-a`/`instance-1`. */
function baseSealParams(overrides: Partial<SealParams> = {}): SealParams {
  return {
    provider: makeFixtureProvider(['session']),
    purpose: 'session',
    encVersion: 1,
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
    ...overrides,
  };
}

/** Baseline open params mirroring `baseSealParams` (minus `encVersion`). */
function baseOpenParams(overrides: Partial<OpenParams> = {}): OpenParams {
  return {
    provider: makeFixtureProvider(['session']),
    purpose: 'session',
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
    ...overrides,
  };
}

const PLAINTEXT = Buffer.from('super secret session material', 'utf8');

describe('rewrapDek - edge cases', () => {
  it('rewrapping_to_the_SAME_active_kek_id_still_produces_a_fresh_wrap_not_a_no_op', () => {
    // Pin the behavior: rewrapDek always re-wraps with a fresh IV, even when
    // `toKekId` equals the blob's current `kek_id` - it never short-circuits
    // to a byte-identical no-op, so every rotation call is auditable/fresh.
    const blob = seal(PLAINTEXT, baseSealParams());
    expect(blob.kek_id).toBe('k2');

    const rewrapped = rewrapDek(blob, 'k2', {
      provider: makeFixtureProvider(['session']),
      purpose: 'session',
    });

    expect(rewrapped.kek_id).toBe('k2');
    expect(rewrapped.dek_iv.equals(blob.dek_iv)).toBe(false);
    expect(rewrapped.dek_wrapped.equals(blob.dek_wrapped)).toBe(false);
    // Record layer is untouched either way.
    expect(rewrapped.ciphertext.equals(blob.ciphertext)).toBe(true);

    const opened = open(rewrapped, baseOpenParams());
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });

  it('rewrapping_a_tampered_dek_wrapped_blob_fails_closed', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const tampered = { ...blob, dek_wrapped: Buffer.from(blob.dek_wrapped) };
    tampered.dek_wrapped.writeUInt8(tampered.dek_wrapped.readUInt8(0) ^ 0x01, 0);

    let caught: unknown;
    try {
      rewrapDek(tampered, 'k1', {
        provider: makeFixtureProvider(['session']),
        purpose: 'session',
      });
      throw new Error('expected rewrapDek to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('rewrapping_a_tampered_dek_tag_fails_closed', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    const tampered = { ...blob, dek_tag: Buffer.from(blob.dek_tag) };
    tampered.dek_tag.writeUInt8(tampered.dek_tag.readUInt8(0) ^ 0x01, 0);

    let caught: unknown;
    try {
      rewrapDek(tampered, 'k1', {
        provider: makeFixtureProvider(['session']),
        purpose: 'session',
      });
      throw new Error('expected rewrapDek to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('double_rotation_k1_to_k9_to_k1_retired_is_rejected_on_the_final_hop', () => {
    const k1Material = Buffer.alloc(32, 0x01).toString('base64');
    const k9Material = Buffer.alloc(32, 0x09).toString('base64');
    const tsMaterial = Buffer.alloc(32, 0x03).toString('base64');
    const usMaterial = Buffer.alloc(32, 0x04).toString('base64');

    // Timeline 1: k1 active, k9 doesn't exist yet.
    const ringT1Path = writeTempRing({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'ts1',
        'user-secrets': 'us1',
        'optout-pepper': 'op1',
        'api-key-pepper': 'akp1',
      },
      keys: {
        k1: {
          purpose: 'session',
          material: k1Material,
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
    const providerT1 = new FileKeyProvider({
      ringPath: ringT1Path,
      mountedPurposes: ['session'],
    });
    const blob = seal(PLAINTEXT, baseSealParams({ provider: providerT1 }));
    expect(blob.kek_id).toBe('k1');

    // Timeline 2: k1 retired, k9 active - first rotation hop k1 -> k9.
    const ringT2Path = writeTempRing({
      version: 1,
      active: {
        session: 'k9',
        'tenant-secrets': 'ts1',
        'user-secrets': 'us1',
        'optout-pepper': 'op1',
        'api-key-pepper': 'akp1',
      },
      keys: {
        k1: {
          purpose: 'session',
          material: k1Material,
          created_at: '2026-01-01T00:00:00.000Z',
          retired: true,
        },
        k9: {
          purpose: 'session',
          material: k9Material,
          created_at: '2026-02-01T00:00:00.000Z',
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
    const providerT2 = new FileKeyProvider({
      ringPath: ringT2Path,
      mountedPurposes: ['session'],
    });
    const rotatedToK9 = rewrapDek(blob, 'k9', {
      provider: providerT2,
      purpose: 'session',
    });
    expect(rotatedToK9.kek_id).toBe('k9');
    expect(open(rotatedToK9, baseOpenParams({ provider: providerT2 })).equals(PLAINTEXT)).toBe(
      true,
    );

    // Second hop k9 -> k1: k1 is now retired in this same ring, so rotating
    // BACK to it must be rejected - a retired key is never a valid target.
    let caught: unknown;
    try {
      rewrapDek(rotatedToK9, 'k1', {
        provider: providerT2,
        purpose: 'session',
      });
      throw new Error('expected rewrapDek to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_KEY_UNAVAILABLE');
    expect((caught as CryptoError).kekId).toBe('k1');
  });
});
