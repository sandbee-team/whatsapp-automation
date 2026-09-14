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
 * notifications-api.integration.test.ts (P17 U6, step 6) - the in-app
 * notifications list/unread-count/mark-read API against real Postgres.
 * KEYSET PROOF (canon): seeds more than one page for tenant A plus rows for
 * an unrelated tenant B, walks every page purely by `nextCursor`, and greps
 * every statement this module issues for the literal `OFFSET` keyword - the
 * mechanical proof that pagination never falls back to a client-constructed
 * offset (`scripts/check-sql-lint.ts`'s own twin rule covers `db/**\/*.sql`;
 * this module's SQL is inlined TypeScript, so the assertion below is this
 * suite's OWN mechanical check over the same source file).
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notifications-api-test',
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

describe('notifications in-app API (P17 U6, real Postgres)', () => {
  it('the_notification_list_is_keyset_paginated_and_tenant_scoped', async () => {
    const tenantA = await seedNotifyTenant(pool);
    seededClientIds.push(tenantA.clientId);
    const tenantB = await seedNotifyTenant(pool);
    seededClientIds.push(tenantB.clientId);

    const base = Date.now();
    // 5 rows for tenant A, strictly increasing created_at, oldest first.
    const tenantAIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await seedNotification(pool, {
        clientId: tenantA.clientId,
        instanceId: tenantA.instanceId,
        createdAt: new Date(base + i * 1000),
      });
      tenantAIds.push(id);
    }
    // Tenant B rows must never appear in tenant A's list.
    await seedNotification(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      createdAt: new Date(base + 10_000),
    });

    // Walk tenant A's list, 2 at a time (newest-first), by cursor only.
    const seenIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listNotificationsForClient(tenantDb, {
        clientId: tenantA.clientId,
        limit: 2,
        cursor,
      });
      seenIds.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seenIds).toHaveLength(5);
    expect(new Set(seenIds)).toEqual(new Set(tenantAIds));
    // Newest-first: the LAST seeded row (highest created_at) is seen first.
    expect(seenIds[0]).toBe(tenantAIds[4]);
    expect(seenIds.some((id) => id === tenantAIds[0])).toBe(true);

    // Tenant B never leaks into tenant A's pages.
    const tenantBList = await listNotificationsForClient(tenantDb, {
      clientId: tenantB.clientId,
      limit: 25,
    });
    expect(tenantBList.items.every((item) => !tenantAIds.includes(item.id))).toBe(true);
    expect(seenIds.every((id) => tenantBList.items.every((item) => item.id !== id))).toBe(true);

    // Mechanical proof: this module's own SQL text never uses OFFSET.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const repoFile = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      'notifications.repo.ts',
    );
    const source = fs.readFileSync(repoFile, 'utf8');
    // Scoped to actual SQL template-literal bodies only (backtick strings) -
    // this module's own doc-comment prose legitimately names the OFFSET
    // keyword when explaining why it is never used, so a whole-file scan
    // would false-positive on its own documentation.
    const sqlLiterals = source.match(/`[^`]*`/gs) ?? [];
    for (const literal of sqlLiterals) {
      expect(literal).not.toMatch(/\bOFFSET\s+/);
    }
  });

  it('unread_true_honors_read_at_and_unread_count_matches', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    const base = Date.now();

    const readId = await seedNotification(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      createdAt: new Date(base),
      readAt: new Date(base),
    });
    const unreadId = await seedNotification(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      createdAt: new Date(base + 1000),
    });

    const unreadOnly = await listNotificationsForClient(tenantDb, {
      clientId: tenant.clientId,
      limit: 25,
      unread: true,
    });
    expect(unreadOnly.items.map((item) => item.id)).toEqual([unreadId]);
    expect(unreadOnly.items.some((item) => item.id === readId)).toBe(false);

    const count = await unreadCountForClient(tenantDb, tenant.clientId);
    expect(count).toBe(1);
  });

  it('mark_read_and_read_all_mutate_only_own_tenant_rows', async () => {
    const tenantA = await seedNotifyTenant(pool);
    seededClientIds.push(tenantA.clientId);
    const tenantB = await seedNotifyTenant(pool);
    seededClientIds.push(tenantB.clientId);
    const base = Date.now();

    const aId1 = await seedNotification(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      createdAt: new Date(base),
    });
    const aId2 = await seedNotification(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      createdAt: new Date(base + 1000),
    });
    const bId1 = await seedNotification(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      createdAt: new Date(base + 2000),
    });

    const marked = await markNotificationRead(tenantDb, {
      clientId: tenantA.clientId,
      id: aId1,
      userId: tenantA.ownerUserId,
    });
    expect(marked.id).toBe(aId1);

    // Idempotent repeat: same readAt, never an error, never a second write.
    const markedAgain = await markNotificationRead(tenantDb, {
      clientId: tenantA.clientId,
      id: aId1,
      userId: tenantA.ownerUserId,
    });
    expect(markedAgain.readAt).toBe(marked.readAt);

    // Cross-tenant mark-read must never touch tenant B's row.
    const bBefore = await pool.query<{ read_at: Date | null }>(
      'SELECT read_at FROM notifications WHERE id = $1',
      [bId1],
    );
    expect(bBefore.rows[0]?.read_at).toBeNull();

    const readAllResult = await markAllNotificationsRead(tenantDb, {
      clientId: tenantA.clientId,
      userId: tenantA.ownerUserId,
    });
    // Only aId2 was still unread for tenant A (aId1 already read above).
    expect(readAllResult.updated).toBe(1);

    const aRows = await pool.query<{ id: string; read_at: Date | null }>(
      'SELECT id, read_at FROM notifications WHERE client_id = $1',
      [tenantA.clientId],
    );
    expect(aRows.rows.every((row) => row.read_at !== null)).toBe(true);
    expect(aRows.rows.map((row) => row.id).sort()).toEqual([aId1, aId2].sort());

    const bAfter = await pool.query<{ read_at: Date | null }>(
      'SELECT read_at FROM notifications WHERE id = $1',
      [bId1],
    );
    expect(bAfter.rows[0]?.read_at).toBeNull();
  });
});
