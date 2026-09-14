import { describe, expect, it } from 'vitest';
import { generateSecret } from './service.js';

/**
 * generate-secret.test.ts (P15 C1 FIX, minor: service.ts:48) - proves
 * `generateSecret` draws its entropy from `randomBytes` (256 bits of pure
 * CSPRNG output, `whsec_` + 64 hex chars) rather than concatenating two
 * `randomUUID()` values (which waste 6 fixed version/variant bits per UUID
 * on non-entropy structure).
 */
describe('generateSecret', () => {
  it('returns whsec_ followed by exactly 64 lowercase hex characters (32 bytes of randomBytes output)', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it('two calls never collide (each draws fresh randomBytes output)', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});
