import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DUMMY_SECRET_HASH, hashApiKeySecret, verifyApiKeySecret } from './hash.js';

/**
 * hash.test.ts (api-keys U2) - `hashApiKeySecret`/`verifyApiKeySecret` are
 * pure functions over caller-supplied peppers (no config/I-O reached), so
 * this file never touches `@wp/server-kit` and needs no env stub. Timing is
 * never asserted here (core-invariants.md forbids wall-clock assertions);
 * only exact buffer/byte-length outcomes are checked.
 */
describe('hashApiKeySecret', () => {
  it('the_same_secret_and_pepper_hash_identically_and_a_different_pepper_does_not', () => {
    const secret = 'a'.repeat(64);
    const pepper = randomBytes(32);
    const otherPepper = randomBytes(32);

    const first = hashApiKeySecret(secret, pepper);
    const second = hashApiKeySecret(secret, pepper);
    const withOtherPepper = hashApiKeySecret(secret, otherPepper);

    expect(first.equals(second)).toBe(true);
    expect(first.equals(withOtherPepper)).toBe(false);
  });
});

describe('verifyApiKeySecret', () => {
  it('verify_rejects_a_secret_that_differs_in_one_character', () => {
    const pepper = randomBytes(32);
    const secret = 'a'.repeat(64);
    const differentSecret = `${'a'.repeat(63)}b`;
    const stored = hashApiKeySecret(secret, pepper);

    expect(verifyApiKeySecret(secret, pepper, stored)).toBe(true);
    expect(verifyApiKeySecret(differentSecret, pepper, stored)).toBe(false);
  });

  it('verify_rejects_a_hash_of_the_wrong_length', () => {
    const pepper = randomBytes(32);
    const secret = 'a'.repeat(64);
    const wrongLengthHash = randomBytes(31);

    expect(verifyApiKeySecret(secret, pepper, wrongLengthHash)).toBe(false);
  });

  it('dummy_hash_is_thirty_two_bytes', () => {
    expect(DUMMY_SECRET_HASH.length).toBe(32);
  });
});
