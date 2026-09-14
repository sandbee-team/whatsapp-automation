import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { publishWakeForClient } from './resume-wake.js';

/**
 * resume-wake.test.ts (P19 Unit U4, step 5) - unit-level (fake `db`/
 * `publishWake`, no real Postgres/Redis): proves the fan-out shape and the
 * "a failed publish never rolls back or throws" contract in isolation from
 * the credit transaction itself (the transaction-boundary/commit ordering
 * proof lives in the `credit.service` integration test per the dispatch).
 */

function fakeDb(rows: { id: string }[]): TenantQueryable {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as TenantQueryable;
}

describe('publishWakeForClient', () => {
  it('a_topup_publishes_a_wake_for_every_instance_of_the_client', async () => {
    const clientId = 'client-1';
    const db = fakeDb([{ id: 'inst-1' }, { id: 'inst-2' }, { id: 'inst-3' }]);
    const published: Array<[string, string]> = [];
    const publishWake = vi.fn((c: string, i: string) => {
      published.push([c, i]);
    });

    await publishWakeForClient({ db, publishWake }, clientId);

    expect(published).toEqual([
      [clientId, 'inst-1'],
      [clientId, 'inst-2'],
      [clientId, 'inst-3'],
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'), [
      clientId,
    ]);
  });

  it('a_deleted_instance_gets_no_wake_and_another_tenant_gets_none', async () => {
    // The query itself is the tenant/deleted_at filter (client_id = $1 AND
    // deleted_at IS NULL) - this test proves the function only ever
    // publishes for rows the query actually returned, never a wider set.
    const clientId = 'client-1';
    const db = fakeDb([{ id: 'inst-1' }]); // simulates the deleted row + other-tenant rows already filtered out by SQL
    const published: Array<[string, string]> = [];
    const publishWake = vi.fn((c: string, i: string) => {
      published.push([c, i]);
    });

    await publishWakeForClient({ db, publishWake }, clientId);

    expect(published).toEqual([[clientId, 'inst-1']]);
  });

  it('zero_instances_publishes_nothing', async () => {
    const db = fakeDb([]);
    const publishWake = vi.fn();

    await publishWakeForClient({ db, publishWake }, 'client-1');

    expect(publishWake).not.toHaveBeenCalled();
  });

  it('a_failed_wake_publish_does_not_roll_back_or_lose_the_credit', async () => {
    const clientId = 'client-1';
    const db = fakeDb([{ id: 'inst-1' }, { id: 'inst-2' }]);
    const errors: Array<[string, string, unknown]> = [];
    const publishWake = vi.fn((_c: string, i: string) => {
      if (i === 'inst-1') {
        throw new Error('redis down');
      }
    });

    await expect(
      publishWakeForClient(
        {
          db,
          publishWake,
          onPublishError: (c, i, err) => {
            errors.push([c, i, err]);
          },
        },
        clientId,
      ),
    ).resolves.toBeUndefined();

    // The credit itself already committed before this function ever runs
    // (caller contract - see module header); this function's own job is
    // only to never THROW past a per-instance publish failure, so the
    // caller's own success return is unaffected and the second instance
    // still gets its wake.
    expect(publishWake).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([[clientId, 'inst-1', expect.any(Error)]]);
  });
});
