import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { resolvePriceKey } from '@wp/domain';
import { materialiseMaxRate, resolveRateMinor, UnpricedKeyError } from './pricing.js';

/**
 * pricing.test.ts (P18 Unit U2) - pure/fake-tx proofs for the price book:
 * `resolvePriceKey`'s payload-kind/group mapping, and that an unpriced key
 * is a NAMED error rather than a silent 0 rate (which would let the claim
 * predicate admit a client who can never actually be charged).
 */

function fakeTx(rows: Array<{ price_key: string; rate_minor: string | null }>): TenantQueryable & {
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  return {
    calls,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      calls.push({ sql, params });
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
  };
}

describe('resolvePriceKey', () => {
  it('resolve_price_key_maps_payload_kind_and_group_recipients', () => {
    expect(
      resolvePriceKey({ payloadKind: 'text', recipientJid: '15550000000@s.whatsapp.net' }),
    ).toBe('text');
    expect(
      resolvePriceKey({ payloadKind: 'media', recipientJid: '15550000000@s.whatsapp.net' }),
    ).toBe('media');
    expect(resolvePriceKey({ payloadKind: 'text', recipientJid: '123456@g.us' })).toBe(
      'group_text',
    );
    expect(resolvePriceKey({ payloadKind: 'media', recipientJid: '123456@g.us' })).toBe(
      'group_media',
    );
    expect(
      resolvePriceKey({ payloadKind: 'reply', recipientJid: '15550000000@s.whatsapp.net' }),
    ).toBe('text');
    expect(resolvePriceKey({ payloadKind: 'unknown-kind', recipientJid: '123456@g.us' })).toBe(
      'group_text',
    );
  });
});

describe('resolveRateMinor', () => {
  it('an_unpriced_price_key_is_a_named_error_not_a_zero_rate', async () => {
    const noRow = fakeTx([]);
    await expect(resolveRateMinor(noRow, 'client-1', 'text')).rejects.toMatchObject({
      code: 'WALLET_UNPRICED_KEY',
      name: 'UnpricedKeyError',
    });
    await expect(resolveRateMinor(noRow, 'client-1', 'text')).rejects.toBeInstanceOf(
      UnpricedKeyError,
    );

    const nullRate = fakeTx([{ price_key: 'text', rate_minor: null }]);
    await expect(resolveRateMinor(nullRate, 'client-1', 'text')).rejects.toMatchObject({
      code: 'WALLET_UNPRICED_KEY',
    });

    const zeroRate = fakeTx([{ price_key: 'text', rate_minor: '0' }]);
    const result = resolveRateMinor(zeroRate, 'client-1', 'text');
    await expect(result).rejects.toMatchObject({ code: 'WALLET_UNPRICED_KEY' });
    // the resolved value is never 0 - the rejection above is the proof; a
    // second assertion would only re-observe the same rejection, so instead
    // confirm the promise never resolves to anything at all:
    await expect(result).rejects.toBeDefined();
  });
});

describe('materialiseMaxRate', () => {
  it('materialise_max_rate_writes_nothing_when_any_key_is_unpriced', async () => {
    const tx = fakeTx([
      { price_key: 'text', rate_minor: '15' },
      { price_key: 'media', rate_minor: '25' },
      { price_key: 'group_text', rate_minor: null },
      { price_key: 'group_media', rate_minor: '25' },
    ]);

    await expect(materialiseMaxRate(tx, 'client-1')).rejects.toMatchObject({
      code: 'WALLET_UNPRICED_KEY',
      message: expect.stringContaining('group_text'),
    });

    const wroteUpdate = tx.calls.some((call) => /UPDATE\s+wallet_accounts/i.test(call.sql));
    expect(wroteUpdate).toBe(false);
  });
});
