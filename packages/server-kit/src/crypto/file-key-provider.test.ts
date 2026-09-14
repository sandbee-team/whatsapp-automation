import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

/**
 * The four deterministic 32-byte material values baked into
 * `test/fixtures/key-ring.dev.json` (k1..k4) - the fourth named test greps
 * every observable surface of the provider for these exact strings.
 */
const FIXTURE_MATERIAL_BASE64 = [
  'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', // k1 (session, retired)
  'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=', // k2 (session, active)
  'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=', // k3 (tenant-secrets, active)
  'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=', // k4 (user-secrets, active)
];

/** Writes `content` to a fresh temp file and returns its path. */
function writeTempRing(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-key-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('FileKeyProvider', () => {
  it('a_missing_purpose_key_throws_CRYPTO_KEY_UNAVAILABLE', () => {
    // Booted without the `session` purpose mounted - mirrors a process
    // (e.g. the API) that never loads session material. Threat model row 4:
    // an RCE in this process cannot decrypt a session blob, because the key
    // was never read off disk in the first place.
    const provider = new FileKeyProvider({
      ringPath: FIXTURE_RING_PATH,
      mountedPurposes: ['tenant-secrets', 'user-secrets'],
    });

    try {
      provider.getActive('session');
      throw new Error('expected getActive to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe('CRYPTO_KEY_UNAVAILABLE');
    }

    try {
      provider.get('k2', 'session');
      throw new Error('expected get to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe('CRYPTO_KEY_UNAVAILABLE');
    }
  });

  it('a_retired_kek_opens_but_never_seals', () => {
    const provider = new FileKeyProvider({
      ringPath: FIXTURE_RING_PATH,
      mountedPurposes: ['session'],
    });

    // Open path: a retired key still opens old ciphertext.
    const retired = provider.get('k1', 'session');
    expect(retired.kekId).toBe('k1');
    expect(retired.retired).toBe(true);

    // Seal path: the active key is the non-retired k2, never k1.
    const active = provider.getActive('session');
    expect(active.kekId).toBe('k2');
    expect(active.retired).toBe(false);
  });

  it('get_throws_CRYPTO_PURPOSE_MISMATCH_when_the_kekId_belongs_to_another_purpose', () => {
    const provider = new FileKeyProvider({
      ringPath: FIXTURE_RING_PATH,
      mountedPurposes: ['session', 'tenant-secrets'],
    });

    try {
      provider.get('k3', 'session');
      throw new Error('expected get to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe('CRYPTO_PURPOSE_MISMATCH');
    }
  });

  it('a_key_ring_with_short_or_non_base64_material_fails_to_load', () => {
    // Both malformed rings below define ALL FOUR purposes with otherwise
    // valid `active`/`keys` entries (matching kekId, matching purpose,
    // non-retired, valid 32-byte-base64 material for the three that aren't
    // under test) - so the bad `session` material is the ONLY defect in the
    // ring, and rejection actually proves the 32-byte/base64 refinement
    // fires, rather than the schema's separate "every purpose must resolve"
    // cross-field check (which rejects a ring missing `tenant-secrets`/
    // `user-secrets`/`optout-pepper` regardless of material).
    const shortMaterialRing = writeTempRing(
      JSON.stringify({
        version: 1,
        active: {
          session: 'k1',
          'tenant-secrets': 'k3',
          'user-secrets': 'k4',
          'optout-pepper': 'k5',
        },
        keys: {
          k1: {
            purpose: 'session',
            material: Buffer.alloc(16, 0x09).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k3: {
            purpose: 'tenant-secrets',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k4: {
            purpose: 'user-secrets',
            material: Buffer.alloc(32, 0x06).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k5: {
            purpose: 'optout-pepper',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    let shortMaterialError: unknown;
    try {
      new FileKeyProvider({
        ringPath: shortMaterialRing,
        mountedPurposes: ['session'],
      });
      throw new Error('expected construction to throw');
    } catch (err) {
      shortMaterialError = err;
    }
    expect(shortMaterialError).toBeInstanceOf(CryptoError);
    expect((shortMaterialError as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
    expect(String(shortMaterialError)).not.toContain(Buffer.alloc(16, 0x09).toString('base64'));

    const nonBase64Ring = writeTempRing(
      JSON.stringify({
        version: 1,
        active: {
          session: 'k1',
          'tenant-secrets': 'k3',
          'user-secrets': 'k4',
          'optout-pepper': 'k5',
        },
        keys: {
          k1: {
            purpose: 'session',
            material: 'not-base64!!!',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k3: {
            purpose: 'tenant-secrets',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k4: {
            purpose: 'user-secrets',
            material: Buffer.alloc(32, 0x06).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k5: {
            purpose: 'optout-pepper',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    let nonBase64Error: unknown;
    try {
      new FileKeyProvider({
        ringPath: nonBase64Ring,
        mountedPurposes: ['session'],
      });
      throw new Error('expected construction to throw');
    } catch (err) {
      nonBase64Error = err;
    }
    expect(nonBase64Error).toBeInstanceOf(CryptoError);
    expect((nonBase64Error as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
    expect(String(nonBase64Error)).not.toContain('not-base64!!!');
    expect((nonBase64Error as CryptoError).stack ?? '').not.toContain('not-base64!!!');
  });

  it('key_material_never_appears_in_an_error_or_a_log_line', () => {
    const provider = new FileKeyProvider({
      ringPath: FIXTURE_RING_PATH,
      mountedPurposes: ['session', 'tenant-secrets', 'user-secrets'],
    });

    const surfaces: string[] = [
      JSON.stringify(provider),
      inspect(provider),
      JSON.stringify(provider.get('k1', 'session')),
      JSON.stringify(provider.getActive('session')),
      inspect(provider.get('k1', 'session')),
    ];

    const caughtErrors: unknown[] = [];
    const unmountedProvider = new FileKeyProvider({
      ringPath: FIXTURE_RING_PATH,
      mountedPurposes: [],
    });
    try {
      unmountedProvider.getActive('session');
    } catch (err) {
      caughtErrors.push(err);
    }
    try {
      provider.get('k3', 'session');
    } catch (err) {
      caughtErrors.push(err);
    }
    try {
      provider.get('does-not-exist', 'session');
    } catch (err) {
      caughtErrors.push(err);
    }

    for (const err of caughtErrors) {
      surfaces.push(JSON.stringify(err));
      surfaces.push(String(err));
      surfaces.push((err as Error).stack ?? '');
    }

    const haystack = surfaces.join('\n');
    for (const material of FIXTURE_MATERIAL_BASE64) {
      expect(haystack).not.toContain(material);
    }
  });
});
