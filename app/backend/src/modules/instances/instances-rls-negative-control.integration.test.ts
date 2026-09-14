import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { provisioningRepo } from '../tenancy/index.js';
import { cleanupProbeClients, type TestPool } from './__tests__/instances-test-helpers.js';

/**
 * instances-rls-negative-control.integration.test.ts (2026-09-14)
 *
 * THE NEGATIVE CONTROL THE EXISTING wp_app TEST COULD NOT PROVIDE.
 *
 * `instance-transitions.wp-app-role.integration.test.ts` proves migration
 * 0023's GRANTs are real, but its `ctxAsWpApp` executor sets
 * `app.client_id` before EVERY statement. Production (before this fix) did
 * not: `instances.routes-support.ts#sqlFor` handed out a bare `pg.Pool`. So
 * that test structurally could not observe the defect, and a green gate meant
 * nothing here. This file pins the missing half.
 *
 * WHY NO TEST CAUGHT IT: dev/test connects as the superuser `wp`, which has
 * `rolbypassrls = t`. The production roles do not. Under the superuser every
 * bare-pool query works perfectly. The ONLY way to see the bug is to execute
 * as the real role, which is what these tests do.
 *
 * Fourth occurrence of this class - see
 * `.memory/lessons/2026-09-11-superuser-dev-db-hides-force-rls-zero-row-reads.md`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'instances-rls-negative-control',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/**
 * Runs one statement as the REAL `wp_app` role with NO `app.client_id` set -
 * i.e. exactly what a bare-pool query looked like in production. Deliberately
 * the mirror image of `ctxAsWpApp`: same role, GUC omitted.
 */
async function queryAsWpAppWithoutTenant(
  sql: string,
  params: unknown[],
): Promise<{ rows: Record<string, unknown>[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_app');
      const result = await client.query(sql, params);
      await client.query('ROLLBACK');
      return { rows: result.rows as Record<string, unknown>[] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

async function seedClient(): Promise<string> {
  const clientId = randomUUID();
  probeClientIds.push(clientId);
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'RLS Negative Control Co',
    `rls-neg-${clientId}`,
    'active',
  ]);
  return clientId;
}

describe('FORCE RLS under the real wp_app role (negative control)', () => {
  it('an_audit_log_insert_without_the_tenant_guc_is_REJECTED', async () => {
    const clientId = await seedClient();

    // The `audit_logs` policy is ENABLE + FORCE RLS with
    // `WITH CHECK (client_id = current_setting('app.client_id'))`. With the
    // GUC unset that comparison is against NULL, so the INSERT must be
    // refused outright (SQLSTATE 42501). This is the exact statement four
    // instances routes used to issue on a bare pool.
    await expect(
      queryAsWpAppWithoutTenant(
        `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id)
         VALUES ($1, 'user', 'instance.parked', 'instance', $2)`,
        [clientId, randomUUID()],
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('an_instance_read_without_the_tenant_guc_silently_returns_ZERO_rows', async () => {
    const clientId = await seedClient();
    const instanceId = randomUUID();
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
       VALUES ($1, $2, 'rls-neg-probe', 'unlinked', 'never_linked')`,
      [instanceId, clientId],
    );

    // This is the DANGEROUS half: a `USING` predicate fails SOFT. No error is
    // raised - the row simply is not there. That is why the bug looked like a
    // 404 on an instance the tenant really owns, rather than a crash.
    const bare = await queryAsWpAppWithoutTenant(
      'SELECT id FROM whatsapp_instances WHERE client_id = $1 AND id = $2',
      [clientId, instanceId],
    );
    expect(bare.rows).toHaveLength(0);
  });

  it('both_statements_succeed_through_withTenant_the_way_production_now_runs_them', async () => {
    const clientId = await seedClient();
    const instanceId = randomUUID();
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
       VALUES ($1, $2, 'rls-neg-probe', 'unlinked', 'never_linked')`,
      [instanceId, clientId],
    );

    // The positive control: the SAME two statements, through the SAME role,
    // with `app.client_id` set - which is precisely what `withTenant` does and
    // therefore what `withInstanceCtx` and `buildPerQueryTenantSql` now
    // guarantee. If this ever fails while the two tests above still pass, the
    // GRANTs regressed rather than the tenant context.
    const tenantDb = createTenantDb(pool as never);
    const rows = await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      await provisioningRepo.insertAuditLog(tx, {
        clientId,
        actorType: 'user',
        actorUserId: null,
        action: 'instance.parked',
        targetType: 'instance',
        targetId: instanceId,
      });
      const read = await tx.query<{ id: string }>(
        'SELECT id FROM whatsapp_instances WHERE client_id = $1 AND id = $2',
        [clientId, instanceId],
      );
      return read.rows;
    });

    expect(rows).toHaveLength(1);
  });
});
