import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createContact } from './contacts.repo.js';
import { setContactTags, createContactTag } from './tags.repo.js';
import { ContactLimitReachedError } from './contacts-limits.js';
import {
  buildTestKeyProvider,
  seedClientWithPlan,
  cleanupImportProbeClients,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * contacts-limits-and-tags-concurrency-c2.integration.test.ts (C2 hardening)
 * - two real-Postgres concurrency races the C2 brief calls out by name:
 * `max_contacts` admitted by two racing `createContact` calls at
 * `current = limit - 1`, and `contact_tags.contact_count` under 20
 * concurrent adds then 10 concurrent removes.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-limits-tags-c2-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('max_contacts race at current = limit - 1', () => {
  it('at_most_one_of_two_concurrent_creates_succeeds_when_only_one_slot_remains', async () => {
    const { clientId } = await seedClientWithPlan(pool, {
      label: 'max-contacts-race',
      maxContacts: 2,
    });
    createdClientIds.push(clientId);

    // Fill to current = limit - 1 = 1.
    await tenantDb.withTenant(clientId, (tx) =>
      createContact(tx, {
        clientId,
        createdByUserId: '00000000-0000-0000-0000-000000000000',
        phone: '+919876500101',
        defaultCountry: 'IN',
        keyProvider,
      }),
    );

    const preCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId],
    );
    expect(preCount.rows[0]?.count).toBe('1');

    // FIXED (addendum A): `assertUnderContactLimit` now takes a
    // transaction-scoped, per-client `pg_advisory_xact_lock` BEFORE
    // counting - the invariant is proven by the LOCK itself, never a
    // sampled race outcome (core invariants doc): the second caller BLOCKS
    // until the first commits or rolls back, so it always observes the
    // first caller's COMMITTED count, never a stale pre-insert snapshot.
    // Exactly one of the two concurrent `createContact` calls succeeds; the
    // other throws `ContactLimitReachedError` - deterministic regardless of
    // scheduler/connection-acquisition timing.
    const results = await Promise.allSettled([
      tenantDb.withTenant(clientId, (tx) =>
        createContact(tx, {
          clientId,
          createdByUserId: '00000000-0000-0000-0000-000000000000',
          phone: '+919876500102',
          defaultCountry: 'IN',
          keyProvider,
        }),
      ),
      tenantDb.withTenant(clientId, (tx) =>
        createContact(tx, {
          clientId,
          createdByUserId: '00000000-0000-0000-0000-000000000000',
          phone: '+919876500103',
          defaultCountry: 'IN',
          keyProvider,
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContactLimitReachedError);

    const finalCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId],
    );
    expect(finalCount.rows[0]?.count).toBe('2');
  });
});

describe('contact_tags.contact_count under concurrent link/unlink', () => {
  it('twenty_concurrent_adds_then_ten_concurrent_removes_leaves_the_count_exact', async () => {
    const { clientId } = await seedClientWithPlan(pool, {
      label: 'tag-count-race',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);

    const tag = await tenantDb.withTenant(clientId, (tx) =>
      createContactTag(tx, {
        clientId,
        name: `race-tag-${Date.now()}`,
        createdByUserId: '00000000-0000-0000-0000-000000000000',
      }),
    );

    const contactIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const contact = await tenantDb.withTenant(clientId, (tx) =>
        createContact(tx, {
          clientId,
          createdByUserId: '00000000-0000-0000-0000-000000000000',
          phone: `+9198765${String(20000 + i)}`,
          defaultCountry: 'IN',
          keyProvider,
        }),
      );
      contactIds.push(contact.id);
    }

    // 20 concurrent adds, one per distinct contact.
    await Promise.all(
      contactIds.map((contactId) =>
        tenantDb.withTenant(clientId, (tx) =>
          setContactTags(tx, { clientId, contactId, add: [tag.id] }),
        ),
      ),
    );

    const afterAdds = await pool.query<{ contact_count: number }>(
      'SELECT contact_count FROM contact_tags WHERE client_id = $1 AND id = $2',
      [clientId, tag.id],
    );
    expect(afterAdds.rows[0]?.contact_count).toBe(20);

    // 10 concurrent removes against the first 10 contacts.
    await Promise.all(
      contactIds
        .slice(0, 10)
        .map((contactId) =>
          tenantDb.withTenant(clientId, (tx) =>
            setContactTags(tx, { clientId, contactId, remove: [tag.id] }),
          ),
        ),
    );

    const afterRemoves = await pool.query<{ contact_count: number }>(
      'SELECT contact_count FROM contact_tags WHERE client_id = $1 AND id = $2',
      [clientId, tag.id],
    );
    const linkRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_tag_links WHERE client_id = $1 AND tag_id = $2',
      [clientId, tag.id],
    );

    expect(afterRemoves.rows[0]?.contact_count).toBe(10);
    expect(linkRows.rows[0]?.count).toBe('10');
    expect(afterRemoves.rows[0]?.contact_count).toBe(Number(linkRows.rows[0]?.count));
  });
});
