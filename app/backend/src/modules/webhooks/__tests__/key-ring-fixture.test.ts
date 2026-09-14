import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { makeKeyProvider } from './webhooks-test-support.js';

/**
 * key-ring-fixture.test.ts (P15 U5, step 8) - a small regression guard for
 * this module's own test fixture: `keyRingSchema`'s `active` field is an
 * EXHAUSTIVE record over every `KEK_PURPOSES` member (zod 4's enum-keyed
 * `z.record` semantics, not a partial record) - a ring carrying only the
 * `tenant-secrets` entry fails to parse. `makeKeyProvider` in
 * `webhooks-test-support.ts` builds the full 5-purpose ring for exactly this
 * reason; this test proves that fixture actually constructs successfully so
 * a future edit that reverts to a partial ring fails loudly here rather than
 * as a confusing `CRYPTO_KEY_RING_INVALID` deep inside an unrelated route
 * test.
 */
describe('webhooks test fixture: makeKeyProvider', () => {
  it('constructs_successfully_against_the_full_kek_purposes_ring', () => {
    expect(() => makeKeyProvider()).not.toThrow();
  });

  it('a_partial_active_record_is_rejected_by_the_schema_not_accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-webhooks-partial-ring-'));
    const path = join(dir, 'key-ring.json');
    const material = Buffer.alloc(32, 0x0c).toString('base64');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        active: { 'tenant-secrets': 'k1' },
        keys: {
          k1: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        },
      }),
      'utf8',
    );
    expect(
      () => new FileKeyProvider({ ringPath: path, mountedPurposes: ['tenant-secrets'] }),
    ).toThrow();
  });
});
