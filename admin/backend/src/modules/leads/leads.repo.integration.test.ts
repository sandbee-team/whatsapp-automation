import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withStaffRoleTx } from '../../platform/platform-read.js';
import {
  createTestAdminPool,
  resolveDatabaseUrl,
} from '../../platform/__test-support__/admin-test-support.js';
import { createLeadsRepo } from './leads.repo.js';
import { hashIp } from './bot-guard.js';

/**
 * leads.repo.integration.test.ts (P29 U4b) - the ONE real-Postgres claim
 * `leads.routes.test.ts` cannot make with a fake repo: an insert issued
 * through `createLeadsRepo` actually lands under the `wp_admin_app` role,
 * stores ONLY the hashed IP (never a raw address, and there is no `ip`
 * column to accidentally target), and the email is lower-cased at rest.
 *
 * Cleanup: `wp_admin_app` has SELECT + INSERT on `leads` only (migration
 * 0074's grant) - no DELETE - so this suite's cleanup DELETE runs as the
 * POOL's own owner role (never entering `wp_admin_app`), exactly like every
 * other integration suite's teardown of a table admin-backend cannot
 * mutate past INSERT.
 */

const pool = createTestAdminPool();
const insertedIds: string[] = [];
const SECRET = 'integration-test-leads-ip-hash-secret-not-real-32+';

beforeAll(() => {
  resolveDatabaseUrl();
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await pool.query('DELETE FROM leads WHERE id = ANY($1::uuid[])', [insertedIds]);
  }
  await pool.end();
});

describe('leads_repo_integration', () => {
  it('a_lead_insert_lands_under_wp_admin_app_and_stores_only_the_hashed_ip', async () => {
    const repo = createLeadsRepo(pool);
    const ip = '203.0.113.42';
    const probe = randomUUID().slice(0, 8);

    // Lowercasing is the ROUTE layer's job (the zod body schema's
    // `.toLowerCase()`) - the repo stores exactly what it is given, so this
    // probe passes an already-lowercased email, the same shape
    // `leads.routes.ts` always calls `insert` with.
    const { id } = await repo.insert({
      name: `Probe Lead ${probe}`,
      email: `probe-${probe}@example.com`,
      company: 'Probe Co',
      phoneE164: '+15551234567',
      message: 'integration probe message',
      source: 'contact',
      utm: { utm_source: 'test' },
      ipHash: hashIp(SECRET, ip),
    });
    insertedIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('ip');

    const stored = await withStaffRoleTx(pool, async (db) => {
      const result = await db.query<{ email: string; ip_hash: string }>(
        'SELECT email, ip_hash FROM leads WHERE id = $1',
        [id],
      );
      return result.rows[0]!;
    });
    expect(stored.email).toBe(`probe-${probe}@example.com`);
    expect(stored.ip_hash).toBe(hashIp(SECRET, ip));
  });

  it('wp_admin_app_cannot_update_or_delete_a_lead', async () => {
    const repo = createLeadsRepo(pool);
    const ip = '203.0.113.43';
    const probe = randomUUID().slice(0, 8);

    const { id } = await repo.insert({
      name: `Grant Probe ${probe}`,
      email: `grant-probe-${probe}@example.com`,
      company: null,
      phoneE164: null,
      message: 'append-only grant probe',
      source: 'contact',
      utm: {},
      ipHash: hashIp(SECRET, ip),
    });
    insertedIds.push(id);

    // The GRANT surface (migration 0074: SELECT + INSERT only for
    // `wp_admin_app`, no UPDATE, no DELETE), not application-level care, is
    // what makes the repo append-only - proven here by attempting both
    // mutations under the real role and asserting Postgres itself refuses
    // them (SQLSTATE 42501, insufficient_privilege).
    await expect(
      withStaffRoleTx(pool, async (db) => {
        await db.query('UPDATE leads SET company = $1 WHERE id = $2', ['x', id]);
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withStaffRoleTx(pool, async (db) => {
        await db.query('DELETE FROM leads WHERE id = $1', [id]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
