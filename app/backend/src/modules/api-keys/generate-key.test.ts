import { describe, expect, it } from 'vitest';
import { generateApiKey, parseApiKey } from './generate-key.js';

/**
 * generate-key.test.ts (api-keys U2) - proves `generateApiKey` draws its
 * entropy from `randomBytes` (see `generate-key.ts`'s own header comment for
 * why, mirrored from `modules/webhooks/generate-secret.test.ts`) and that
 * `parseApiKey` is a STRICT, anchored parser - any deviation from the exact
 * documented shape returns `null`, never a partial match.
 */
describe('generateApiKey', () => {
  it('a_generated_key_matches_the_documented_format', () => {
    const { key, keyPrefix, secret, last4 } = generateApiKey();

    expect(key).toMatch(/^wp_live_[0-9a-f]{12}_[0-9a-f]{64}$/);
    expect(keyPrefix).toMatch(/^wp_live_[0-9a-f]{12}$/);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(last4).toBe(secret.slice(-4));
    expect(key).toBe(`${keyPrefix}_${secret}`);
  });

  it('a_thousand_keys_are_all_distinct', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });
});

describe('parseApiKey', () => {
  it('parse_rejects_every_malformed_shape', () => {
    const prefix12 = 'a'.repeat(12);
    const secret64 = 'b'.repeat(64);
    const validKey = `wp_live_${prefix12}_${secret64}`;

    const badCases: Record<string, string> = {
      empty: '',
      missing_wp_live_prefix: `xx_live_${prefix12}_${secret64}`,
      prefix_11_chars: `wp_live_${'a'.repeat(11)}_${secret64}`,
      prefix_13_chars: `wp_live_${'a'.repeat(13)}_${secret64}`,
      secret_63_chars: `wp_live_${prefix12}_${'b'.repeat(63)}`,
      secret_65_chars: `wp_live_${prefix12}_${'b'.repeat(65)}`,
      uppercase_prefix: `wp_live_${'A'.repeat(12)}_${secret64}`,
      uppercase_secret: `wp_live_${prefix12}_${'B'.repeat(64)}`,
      trailing_newline: `${validKey}\n`,
      leading_whitespace: ` ${validKey}`,
      extra_underscore: `wp_live_${prefix12}_${secret64}_`,
      embedded_newline: `wp_live_${prefix12}\n_${secret64}`,
    };

    for (const [name, input] of Object.entries(badCases)) {
      expect(parseApiKey(input), name).toBeNull();
    }
  });

  it('parse_accepts_the_exact_happy_case_and_returns_consistent_halves', () => {
    const prefix12 = 'c'.repeat(12);
    const secret64 = 'd'.repeat(64);
    const validKey = `wp_live_${prefix12}_${secret64}`;

    const parsed = parseApiKey(validKey);

    expect(parsed).not.toBeNull();
    expect(parsed?.keyPrefix).toBe(`wp_live_${prefix12}`);
    expect(parsed?.secret).toBe(secret64);
  });
});
