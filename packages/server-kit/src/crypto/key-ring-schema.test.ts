import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';

/**
 * `key-ring-schema.ts` has no dedicated test file of its own - its
 * cross-field validation (`superRefine`) and exhaustiveness rules are
 * exercised here, through `FileKeyProvider`'s construction (the only public
 * entry point that parses a ring). Split out of `file-key-provider.test.ts`
 * to stay under the `max-lines` lint limit.
 */

/** Writes `content` to a fresh temp file and returns its path. */
function writeTempRing(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-key-ring-schema-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('key-ring-schema (via FileKeyProvider construction)', () => {
  it('a_proto_or_constructor_named_kekId_is_harmless_not_a_prototype_pollution_vector', () => {
    // JSON.parse creates "__proto__"/"constructor" as ordinary own keys (it
    // never triggers the Object.prototype.__proto__ setter), so this is
    // primarily proving FileKeyProvider's own Map-based storage never turns
    // that into pollution even if Zod's record parsing ever changed shape.
    const ringPath = writeTempRing(
      JSON.stringify({
        version: 1,
        active: {
          session: 'k2',
          'tenant-secrets': 'k3',
          'user-secrets': 'k4',
          'optout-pepper': 'k5',
          'api-key-pepper': 'k6',
        },
        keys: {
          __proto__: {
            purpose: 'session',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          constructor: {
            purpose: 'session',
            material: Buffer.alloc(32, 0x06).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k2: {
            purpose: 'session',
            material: Buffer.alloc(32, 0x02).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k3: {
            purpose: 'tenant-secrets',
            material: Buffer.alloc(32, 0x03).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k4: {
            purpose: 'user-secrets',
            material: Buffer.alloc(32, 0x04).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k5: {
            purpose: 'optout-pepper',
            material: Buffer.alloc(32, 0x05).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k6: {
            purpose: 'api-key-pepper',
            material: Buffer.alloc(32, 0x06).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    // Global Object.prototype must be untouched no matter what happens below.
    const pollutedBefore = ({} as Record<string, unknown>).polluted;
    const provider = new FileKeyProvider({
      ringPath,
      mountedPurposes: ['session'],
    });
    const pollutedAfter = ({} as Record<string, unknown>).polluted;
    expect(pollutedBefore).toBeUndefined();
    expect(pollutedAfter).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    // Whatever happened to the "__proto__"-named entry, `get` must not throw
    // in a way that leaks material, and must not silently resolve to a
    // poisoned prototype's key.
    let result: unknown;
    try {
      result = provider.get('__proto__', 'session');
    } catch (err) {
      result = err;
    }
    // Either it resolves the literal-string entry, or it's treated as
    // unknown/unavailable - both are acceptable, but it must never throw an
    // unhandled (non-CryptoError) exception or crash.
    if (result instanceof Error) {
      expect(result).toBeInstanceOf(CryptoError);
    }
  });

  it('two_active_purposes_pointing_at_the_same_kekId_is_rejected_by_the_schema', () => {
    // A single kekId's own `purpose` field is fixed to ONE purpose - the
    // schema's superRefine already rejects `active.<otherPurpose>` pointing
    // at a kekId whose purpose doesn't match, which structurally prevents
    // two different purposes ever sharing one kekId. Pin that explicitly.
    // `active` is a `z.record` over the full `KekPurpose` enum (Zod v4
    // enforces this at runtime - a record keyed by an enum requires every
    // enum member present), so all four purposes need an entry here even
    // though only `session`/`tenant-secrets` are under test.
    const ringPath = writeTempRing(
      JSON.stringify({
        version: 1,
        active: {
          session: 'k-shared',
          'tenant-secrets': 'k-shared',
          'user-secrets': 'k4',
          'optout-pepper': 'k5',
        },
        keys: {
          'k-shared': {
            purpose: 'session',
            material: Buffer.alloc(32, 0x07).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          k4: {
            purpose: 'user-secrets',
            material: Buffer.alloc(32, 0x04).toString('base64'),
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

    let caught: unknown;
    try {
      new FileKeyProvider({
        ringPath,
        mountedPurposes: ['session', 'tenant-secrets'],
      });
      throw new Error('expected construction to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
  });

  it('the_schema_itself_requires_every_purpose_present_in_active_so_a_mounted_purpose_can_never_be_silently_missing', () => {
    // Zod v4's `z.record(enumSchema, ...)` requires EVERY enum member as a
    // key - so a ring omitting `tenant-secrets` from `active` fails to load
    // at all, rather than loading and letting `getActive('tenant-secrets')`
    // silently resolve to `undefined` at call time. This is what makes
    // `FileKeyProvider.getActive`'s own `!entry` fail-closed check
    // (CRYPTO_KEY_UNAVAILABLE) effectively unreachable for "purpose absent
    // from active" - the schema closes that gap one layer earlier, at load
    // time, which is a stronger guarantee than a runtime check.
    const ringPath = writeTempRing(
      JSON.stringify({
        version: 1,
        active: { session: 'k1' },
        keys: {
          k1: {
            purpose: 'session',
            material: Buffer.alloc(32, 0x08).toString('base64'),
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    let caught: unknown;
    try {
      new FileKeyProvider({
        ringPath,
        mountedPurposes: ['session', 'tenant-secrets'],
      });
      throw new Error('expected construction to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
  });

  it('a_ring_file_that_is_valid_JSON_but_an_array_at_root_fails_to_load', () => {
    const ringPath = writeTempRing(JSON.stringify([1, 2, 3]));

    let caught: unknown;
    try {
      new FileKeyProvider({ ringPath, mountedPurposes: ['session'] });
      throw new Error('expected construction to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
  });

  it('a_ring_file_that_is_valid_JSON_but_a_string_at_root_fails_to_load', () => {
    const ringPath = writeTempRing(JSON.stringify('just a string'));

    let caught: unknown;
    try {
      new FileKeyProvider({ ringPath, mountedPurposes: ['session'] });
      throw new Error('expected construction to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_KEY_RING_INVALID');
  });
});
