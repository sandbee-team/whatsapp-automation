import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';
import { open, seal } from './envelope.js';
import type { OpenParams, SealParams } from './envelope.js';
import { makeKekEntry } from './key-provider.js';
import type { KeyProvider } from './key-provider.js';
import { rewrapDek } from './rotate.js';

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-rotate-ring-'));
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

describe('rewrapDek', () => {
  it('a_dek_wrapped_for_one_purpose_cannot_be_unwrapped_by_another_purposes_kek', () => {
    // A fake provider that hands back the same entry no matter which
    // purpose is asked for - isolates the property under test to the AAD
    // binding itself (`dekWrapAad`'s `purpose` field), rather than the
    // `FileKeyProvider`-level purpose check `envelope.test.ts` already
    // covers (`open_with_the_wrong_purposes_provider_fails`).
    const entry = makeKekEntry({
      kekId: 'k-shared',
      purpose: 'session',
      material: randomBytes(32),
      retired: false,
    });
    const provider: KeyProvider = {
      getActive: () => entry,
      get: () => entry,
    };

    const blob = seal(PLAINTEXT, baseSealParams({ provider, purpose: 'session' }));

    let caught: unknown;
    try {
      // Same key material, same provider - only `purpose` differs from what
      // the blob was sealed under. The dek-wrap AAD binds to `purpose`, so
      // the GCM auth tag fails even though `provider.get` happily returns
      // the "right" key.
      rewrapDek(blob, 'k-shared', { provider, purpose: 'tenant-secrets' });
      throw new Error('expected rewrapDek to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('rewrap_to_a_retired_kek_is_rejected', () => {
    const blob = seal(PLAINTEXT, baseSealParams());
    expect(blob.kek_id).toBe('k2');

    let caught: unknown;
    try {
      // `k1` is retired in the fixture ring - a retired key must never seal,
      // including as a rotation target.
      rewrapDek(blob, 'k1', {
        provider: makeFixtureProvider(['session']),
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

  it('rewrapDek_preserves_the_record_layer_and_only_changes_the_dek_wrap', () => {
    const k1Material = Buffer.alloc(32, 0x01).toString('base64');
    const k9Material = Buffer.alloc(32, 0x09).toString('base64');
    const tsMaterial = Buffer.alloc(32, 0x03).toString('base64');
    const usMaterial = Buffer.alloc(32, 0x04).toString('base64');

    const ringPath = writeTempRing({
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
    const provider = new FileKeyProvider({
      ringPath,
      mountedPurposes: ['session'],
    });

    const blob = seal(PLAINTEXT, baseSealParams({ provider }));
    expect(blob.kek_id).toBe('k1');

    const rotated = rewrapDek(blob, 'k9', { provider, purpose: 'session' });

    expect(rotated.kek_id).toBe('k9');
    expect(rotated.ciphertext.equals(blob.ciphertext)).toBe(true);
    expect(rotated.iv.equals(blob.iv)).toBe(true);
    expect(rotated.auth_tag.equals(blob.auth_tag)).toBe(true);
    expect(rotated.enc_version).toBe(blob.enc_version);
    expect(rotated.dek_wrapped.equals(blob.dek_wrapped)).toBe(false);
    expect(rotated.dek_iv.equals(blob.dek_iv)).toBe(false);
    expect(rotated.dek_tag.equals(blob.dek_tag)).toBe(false);

    const opened = open(rotated, baseOpenParams({ provider }));
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });
});
