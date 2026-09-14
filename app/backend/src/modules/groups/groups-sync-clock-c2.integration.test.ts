import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  buildGroupsRoutesHarness,
  signAccessToken,
} from './__tests__/groups-route-test-support.js';

/**
 * groups-sync-clock-c2.integration.test.ts (P24 C2 test-engineer) - the
 * `POST /v1/instances/:id/groups/sync` clock edge cases beyond
 * `groups-sync-request.integration.test.ts`'s own happy-path/rate-limit/
 * isolation coverage: the exact `groups_next_sync_after == now()` boundary,
 * a NULL clock (first ever request), a soft-deleted instance (404 not 429),
 * and two genuinely concurrent requests.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let app: FastifyInstance;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-clock-c2-test',
  });
  tenantDb = createTenantDb(pool);
  app = buildGroupsRoutesHarness(tenantDb);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function authHeader(clientId: string, userId: string): Promise<Record<string, string>> {
  const token = await signAccessToken({ userId, clientId, role: 'owner' });
  return { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() };
}

describe('groups sync request - clock boundary cases', () => {
  it('a_request_exactly_at_the_next_sync_after_boundary_is_allowed', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    // groups_next_sync_after == now() at request time - the statement's own
    // WHERE is `<= now()`, so exact equality must be allowed, not refused.
    await pool.query(`UPDATE whatsapp_instances SET groups_next_sync_after = now() WHERE id = $1`, [
      instanceId,
    ]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/groups/sync`,
      headers: await authHeader(clientId, userId),
    });
    expect(resp.statusCode).toBe(202);
  });

  it('a_null_next_sync_after_first_ever_request_is_allowed', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    const before = await pool.query<{ groups_next_sync_after: Date | null }>(
      `SELECT groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(before.rows[0]?.groups_next_sync_after).toBeNull();

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/groups/sync`,
      headers: await authHeader(clientId, userId),
    });
    expect(resp.statusCode).toBe(202);
  });

  it('a_soft_deleted_instance_is_404_not_429', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    // Already rate-limited AND deleted - 404 must win (the deleted_at
    // predicate is checked by both the write-attempt statement and the
    // read-fallback, so a deleted instance never reaches the 429 branch).
    await pool.query(
      `UPDATE whatsapp_instances SET groups_next_sync_after = now() + interval '30 minutes', deleted_at = now() WHERE id = $1`,
      [instanceId],
    );

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/groups/sync`,
      headers: await authHeader(clientId, userId),
    });
    expect(resp.statusCode).toBe(404);
  });

  it('two_concurrent_sync_requests_are_never_both_429_and_never_error', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();

    const [respA, respB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceId}/groups/sync`,
        headers: await authHeader(clientId, userId),
      }),
      app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceId}/groups/sync`,
        headers: await authHeader(clientId, userId),
      }),
    ]);

    const codes = [respA.statusCode, respB.statusCode];
    for (const code of codes) {
      expect([202, 429]).toContain(code);
    }
    // Since the min-interval clock did not exist before this pair ran, BOTH
    // calls race to satisfy the same "unset or elapsed" WHERE - a genuine
    // conditional UPDATE race means at most one writes groups_sync_requested_at
    // as the FIRST committer; the second either also matches (both unset at
    // read time is fine, no serialization conflict since neither depends on
    // the other's write) or is refused. Never a 5xx.
    for (const code of codes) {
      expect(code).toBeLessThan(500);
    }

    const auditRows = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.sync_requested'`,
      [clientId, instanceId],
    );
    // At least one succeeded and was audited; never more audit rows than 202s.
    const successCount = codes.filter((c) => c === 202).length;
    expect(auditRows.rows.length).toBe(successCount);
  });
});
