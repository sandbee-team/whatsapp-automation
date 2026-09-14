import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword, type Argon2Params } from '../password.js';

/**
 * password.test.ts (P04a Unit A4) - unit-only, no DB. Reduced profile keeps
 * the suite fast; exactly ONE test (below) proves the canon PRODUCTION
 * parameters actually work end-to-end, per the phase task's explicit "never
 * weaken production defaults to speed tests up" rule.
 */

const REDUCED_PROFILE: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

// Canon production defaults (platform/config.ts ARGON2_MEMORY_KIB / _TIME_COST / _PARALLELISM).
const PRODUCTION_PROFILE: Argon2Params = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

describe('password (P04a Unit A4, argon2id)', () => {
  it('production_argon2_parameters_hash_and_verify_round_trip', async () => {
    const hash = await hashPassword('correct horse battery staple', PRODUCTION_PROFILE);
    expect(hash).toContain('$argon2id$');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('reduced_profile_hash_and_verify_round_trip', async () => {
    const hash = await hashPassword('reduced-profile-password', REDUCED_PROFILE);
    await expect(verifyPassword(hash, 'reduced-profile-password')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'not-the-password')).resolves.toBe(false);
  });

  it('needsRehash_is_false_when_hash_params_match_current_config', async () => {
    const hash = await hashPassword('same-params', REDUCED_PROFILE);
    expect(needsRehash(hash, REDUCED_PROFILE)).toBe(false);
  });

  it('needsRehash_is_true_when_hash_params_are_weaker_than_current_config', async () => {
    const weakerProfile: Argon2Params = { memoryCost: 4096, timeCost: 1, parallelism: 1 };
    const hash = await hashPassword('weaker-params', weakerProfile);
    expect(needsRehash(hash, REDUCED_PROFILE)).toBe(true);
  });
});
