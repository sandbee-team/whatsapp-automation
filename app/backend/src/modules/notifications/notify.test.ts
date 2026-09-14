import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { notify } from './notify.js';

/**
 * notify.test.ts (P17 U3, step 3) - proves `notify()` REQUIRES the caller's
 * own transaction handle: there is no overload that opens its own
 * transaction (the module doc comment's own contract). A missing/malformed
 * `tx` is a typed rejection here, before any SQL is even attempted - never a
 * silent "well I'll just query the pool myself" fallback.
 */

describe('notify', () => {
  it('notify_requires_a_transaction_handle', async () => {
    await expect(
      notify(undefined as never, {
        clientId: '11111111-1111-4111-8111-111111111111',
        kind: 'instance_paused',
        transitionId: '22222222-2222-4222-8222-222222222222',
        payload: {},
      }),
    ).rejects.toThrow(/transaction/i);
  });

  it('notify_rejects_a_tx_with_no_query_method', async () => {
    await expect(
      notify({} as never, {
        clientId: '11111111-1111-4111-8111-111111111111',
        kind: 'instance_paused',
        transitionId: '22222222-2222-4222-8222-222222222222',
        payload: {},
      }),
    ).rejects.toThrow(/transaction/i);
  });

  it('notify_rejects_an_oversized_payload_before_ever_calling_tx_query_query_never_called', async () => {
    // P17 fix round F5: a typed pre-SQL validation error, never a raw
    // Postgres 23514 CHECK-violation surfacing from `tx.query` - so `tx.query`
    // itself must never even be called for an oversized payload.
    let queryCalled = false;
    const fakeTx = {
      query: async () => {
        queryCalled = true;
        return { rows: [] };
      },
    };

    await expect(
      notify(fakeTx as never, {
        clientId: '11111111-1111-4111-8111-111111111111',
        kind: 'instance_paused',
        transitionId: '22222222-2222-4222-8222-222222222222',
        payload: { blob: 'x'.repeat(3000) },
      }),
    ).rejects.toMatchObject({ code: 'NOTIFY_PAYLOAD_TOO_LARGE' });
    expect(queryCalled).toBe(false);
  });
});
