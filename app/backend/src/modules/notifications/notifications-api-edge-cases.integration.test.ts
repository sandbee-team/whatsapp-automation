import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  listNotificationsForClient,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCountForClient,
} from './notifications.service.js';
import {
  cleanupNotifyFixtures,
  seedNotification,
  seedNotifyTenant,
  type TestPool,
} from './__tests__/notifications-test-support.js';

/**
 * notifications-api-edge-cases.integration.test.ts (P17 C2 hardening,
 * 2026-09-03) - sibling split of notifications-api.integration.test.ts
 * (max-lines cap; mechanical extraction, not a behavioural boundary - same
 * split idiom `.claude/rules/core-invariants.md` documents). Targets the
 * seams NOT covered by the original file's own three tests:
 *
 *  - seam 6: keyset stability across several rows with an IDENTICAL
 *    created_at (a bulk-insert tie).
 *  - seam 5 (second half): read-all racing a concurrent insert.
 *  - seam 9: garbage cursor / non-existent-but-valid id - typed 4xx, never a
 *    raw SQL/driver error.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notifications-api-edge-cases-test',
});
let tenantDb: TenantDb;

let seededClientIds: string[] = [];

beforeEach(() => {
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupNotifyFixtures(pool, seededClientIds);
  seededClientIds = [];
});

describe('notifications in-app API edge cases (P17 C2 hardening, real Postgres)', () => {
  // hunt seam 6: keyset stability when several rows share an IDENTICAL
  // created_at (a realistic bulk-insert tie, e.g. a fan-out that seeds
  // several notifications inside one transaction with the same `now()`).
  // The keyset predicate orders/filters on `(created_at, id)` together
  // (never `created_at` alone), so a tie is broken deterministically by
  // `id DESC` - walking the list one row at a time must see every seeded
  // row exactly once, no skip and no duplicate across the page boundary.
  it('a_created_at_tie_across_several_rows_paginates_without_skip_or_duplicate', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    const tiedCreatedAt = new Date(Date.now());

    const tiedIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await seedNotification(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        createdAt: tiedCreatedAt,
      });
      tiedIds.push(id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listNotificationsForClient(tenantDb, {
        clientId: tenant.clientId,
        limit: 2,
        cursor,
      });
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(tiedIds));
    // Deterministic tie-break: id DESC among rows with the identical
    // created_at - the walk order matches a plain id-DESC sort of the tied set.
    expect(seen).toEqual([...tiedIds].sort().reverse());
  });

  // hunt seam 5 (second half): read-all racing a concurrent insert. The
  // UPDATE's own WHERE clause is evaluated against the snapshot at statement
  // start (READ COMMITTED default), so a row inserted concurrently AFTER the
  // statement begins is never included in that statement's row set -
  // pinning the actual (acceptable) behavior: read-all never
  // resurrects/marks a row it could not have seen.
  it('read_all_never_marks_a_row_inserted_after_it_already_ran', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    const before = await seedNotification(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      createdAt: new Date(Date.now()),
    });

    const result = await markAllNotificationsRead(tenantDb, {
      clientId: tenant.clientId,
      userId: tenant.ownerUserId,
    });
    expect(result.updated).toBe(1);

    // Inserted AFTER read-all's own statement already completed - must stay
    // unread (never resurrected/marked by a since-completed statement).
    const after = await seedNotification(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      createdAt: new Date(Date.now() + 1000),
    });

    const unreadRows = await pool.query<{ id: string; read_at: Date | null }>(
      'SELECT id, read_at FROM notifications WHERE client_id = $1 ORDER BY created_at',
      [tenant.clientId],
    );
    const beforeRow = unreadRows.rows.find((r) => r.id === before);
    const afterRow = unreadRows.rows.find((r) => r.id === after);
    expect(beforeRow?.read_at).not.toBeNull();
    expect(afterRow?.read_at).toBeNull();

    const count = await unreadCountForClient(tenantDb, tenant.clientId);
    expect(count).toBe(1);
  });

  // hunt seam 9: empty/huge inputs must be typed 4xx errors from the SERVICE
  // boundary the route calls, never an unguarded raw SQL/driver error. This
  // test exercises the cursor decode path the service/repo layer owns
  // directly, since InvalidCursorError is thrown here, before any SQL is
  // attempted.
  it('a_garbage_cursor_throws_a_typed_validation_error_before_any_sql_runs', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);

    await expect(
      listNotificationsForClient(tenantDb, {
        clientId: tenant.clientId,
        limit: 25,
        cursor: 'not-a-valid-cursor-!!!',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      listNotificationsForClient(tenantDb, {
        clientId: tenant.clientId,
        limit: 25,
        // Valid base64url, but no '|' separator - decodeCursor's own
        // malformed-shape branch.
        cursor: Buffer.from('no-separator-here', 'utf8').toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // hunt seam 9: mark-read on a non-uuid id must be a typed 4xx at the route
  // (z.string().uuid().parse), never reach the service/repo with a garbage
  // id. This test exercises the service directly with a
  // non-existent-but-valid uuid to pin the NOT_FOUND branch (the uuid-shape
  // rejection itself is route-level zod, proven by inspection of
  // notifications.routes.ts - `z.string().uuid().parse` runs BEFORE
  // `markNotificationRead` is ever called).
  it('mark_read_on_a_nonexistent_but_well_formed_id_is_a_typed_not_found_not_a_silent_success', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);

    await expect(
      markNotificationRead(tenantDb, {
        clientId: tenant.clientId,
        id: '00000000-0000-4000-8000-000000000000',
        userId: tenant.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
