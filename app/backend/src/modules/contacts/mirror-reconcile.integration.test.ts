import { randomBytes } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupMirrorProbeClients,
  seedContact,
  seedLiveOptOut,
  seedProbeClient,
  type TestPool,
} from './__tests__/mirror-test-support.js';
import { runOneMirrorReconcileSweep } from './mirror-reconcile.js';

/**
 * mirror-reconcile.integration.test.ts (P20 Unit U7, step 8) - split out of
 * `optout-mirror.integration.test.ts` purely for that file's own max-lines
 * cap (same split idiom as `session-worker-discovery-wiring.ts`) - real
 * Postgres proof that `runOneMirrorReconcileSweep` repairs drift, is
 * tenant-scoped, is bounded per client, and never writes `opt_outs`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'mirror-reconcile-it',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupMirrorProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function contactRow(
  contactId: string,
): Promise<{ opt_out_state: string; opted_out_at: Date | null }> {
  const result = await pool.query<{ opt_out_state: string; opted_out_at: Date | null }>(
    'SELECT opt_out_state, opted_out_at FROM contacts WHERE id = $1',
    [contactId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('contactRow: no such contact');
  return row;
}

describe('runOneMirrorReconcileSweep', () => {
  it('mirror_reconciler_repairs_the_mirror_and_never_the_authority', async () => {
    const clientA = await seedProbeClient(pool, 'suite-mirror-reconcile-a');
    const clientB = await seedProbeClient(pool, 'suite-mirror-reconcile-b');
    probeClientIds.push(clientA, clientB);

    // A: 3 drifted contacts.
    const phoneHash1 = randomBytes(32);
    const phoneHash2 = randomBytes(32);
    const phoneHash3 = randomBytes(32);
    const phoneHash4 = randomBytes(32); // consistent, no drift
    const contact1 = await seedContact(pool, clientA, {
      phoneHash: phoneHash1,
      optOutState: 'none',
    });
    const contact2 = await seedContact(pool, clientA, {
      phoneHash: phoneHash2,
      optOutState: 'none',
    });
    const contact3 = await seedContact(pool, clientA, {
      phoneHash: phoneHash3,
      optOutState: 'opted_out',
      optedOutAt: new Date(),
    });
    const contact4 = await seedContact(pool, clientA, {
      phoneHash: phoneHash4,
      optOutState: 'none',
    });

    const optOut1CreatedAt = new Date(Date.now() - 60_000);
    await seedLiveOptOut(pool, clientA, {
      scope: 'client',
      scopeKey: clientA,
      phoneHash: phoneHash1,
      createdAt: optOut1CreatedAt,
    });
    const optOut2CreatedAt = new Date(Date.now() - 30_000);
    await seedLiveOptOut(pool, clientA, {
      scope: 'client',
      scopeKey: clientA,
      phoneHash: phoneHash2,
      createdAt: optOut2CreatedAt,
    });
    // contact3: forced opted_out but NO opt_outs row - the reconciler must
    // flip it back to 'none' (repairs the mirror, not the authority).

    // B: 1 drifted contact.
    const bPhoneHash = randomBytes(32);
    const contactB = await seedContact(pool, clientB, {
      phoneHash: bPhoneHash,
      optOutState: 'none',
    });
    const bOptOutCreatedAt = new Date(Date.now() - 45_000);
    await seedLiveOptOut(pool, clientB, {
      scope: 'client',
      scopeKey: clientB,
      phoneHash: bPhoneHash,
      createdAt: bOptOutCreatedAt,
    });

    const optOutsSnapshotBefore = await pool.query(
      'SELECT * FROM opt_outs WHERE client_id = ANY($1) ORDER BY id',
      [[clientA, clientB]],
    );
    const snapshotBefore = JSON.stringify(optOutsSnapshotBefore.rows);

    const tenantDb = createTenantDb(pool);
    const driftCalls: number[] = [];
    const metrics = { incOptoutMirrorDrift: (n: number) => driftCalls.push(n) };

    const sweep1 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientA],
      metrics,
    });
    expect(sweep1.contactsRepaired).toBe(3);
    expect(driftCalls).toEqual([3]);

    const row1 = await contactRow(contact1);
    expect(row1.opt_out_state).toBe('opted_out');
    expect(row1.opted_out_at?.toISOString()).toBe(optOut1CreatedAt.toISOString());
    const row2 = await contactRow(contact2);
    expect(row2.opt_out_state).toBe('opted_out');
    expect(row2.opted_out_at?.toISOString()).toBe(optOut2CreatedAt.toISOString());
    const row3 = await contactRow(contact3);
    expect(row3.opt_out_state).toBe('none');
    expect(row3.opted_out_at).toBeNull();
    const row4 = await contactRow(contact4);
    expect(row4.opt_out_state).toBe('none');

    // B's drifted row is UNCHANGED - tenant scoping.
    const rowB = await contactRow(contactB);
    expect(rowB.opt_out_state).toBe('none');

    const optOutsSnapshotAfter = await pool.query(
      'SELECT * FROM opt_outs WHERE client_id = ANY($1) ORDER BY id',
      [[clientA, clientB]],
    );
    expect(JSON.stringify(optOutsSnapshotAfter.rows)).toBe(snapshotBefore);

    const sweep2 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientA, clientB],
      metrics,
    });
    expect(sweep2.contactsRepaired).toBe(1);

    const sweep3 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientA, clientB],
      metrics,
    });
    expect(sweep3.contactsRepaired).toBe(0);
  });

  it('the_reconciler_is_bounded_per_client', async () => {
    const clientId = await seedProbeClient(pool, 'suite-mirror-bounded');
    probeClientIds.push(clientId);

    const phoneHashes = Array.from({ length: 7 }, () => randomBytes(32));
    for (const phoneHash of phoneHashes) {
      await seedContact(pool, clientId, { phoneHash, optOutState: 'none' });
      await seedLiveOptOut(pool, clientId, { scope: 'client', scopeKey: clientId, phoneHash });
    }

    const tenantDb = createTenantDb(pool);
    const metrics = { incOptoutMirrorDrift: () => undefined };

    const sweep1 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientId],
      metrics,
      limitPerClient: 3,
    });
    expect(sweep1.contactsRepaired).toBe(3);

    const sweep2 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientId],
      metrics,
      limitPerClient: 3,
    });
    expect(sweep2.contactsRepaired).toBe(3);

    const sweep3 = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: async () => [clientId],
      metrics,
      limitPerClient: 3,
    });
    expect(sweep3.contactsRepaired).toBe(1);
  });
});
