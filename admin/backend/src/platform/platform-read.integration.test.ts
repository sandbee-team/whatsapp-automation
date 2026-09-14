import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformRead, withStaffRoleTx, UnregisteredPlatformReadError } from './platform-read.js';
import {
  buildTestAdminApp,
  seedStaffUser,
  totpCodeFor,
  type TestAppHandles,
} from './__test-support__/admin-test-support.js';
import { findForbiddenKeys } from './__test-support__/leak-scan.js';

/**
 * platform-read.integration.test.ts (P28 Unit U4, steps 6-7) - the two
 * BEHAVIOURAL halves of the platform-read guarantee, against a real
 * Postgres (the STRUCTURAL half is `platform-read.test.ts`'s source scan):
 *
 *  1. the audit row and the read share one transaction, in both directions
 *     (commit together, roll back together), and an unregistered key never
 *     even reaches `pool.connect()`;
 *  2. no admin read projection carries recipient/message/person data - not
 *     just "the columns we chose look fine", but a deep scan of every read
 *     endpoint's ACTUAL response against a seeded tenant's distinctive
 *     secrets.
 *
 * Every seeded row is prefixed/id-scoped to this suite and deleted by id in
 * `afterAll`: another unit's integration suite runs against the same
 * `wp_test2` database concurrently, so nothing here counts rows fleet-wide.
 */

let handles: TestAppHandles;
const PROBE = randomUUID().slice(0, 8);

// Distinctive seeded secrets - if ANY of these strings appears in ANY read
// endpoint's response body, a projection is leaking.
const SECRET_PHONE = '+919999911111';
const SECRET_LABEL = `SECRET LABEL 4711 ${PROBE}`;
const SECRET_BODY = `SECRET BODY 4711 ${PROBE}`;
const SECRET_UTR = `SECRET-UTR-4711-${PROBE}`;
const SECRET_OWNER_NAME = `Secret Owner Name 4711 ${PROBE}`;
const SECRET_OWNER_EMAIL = `secret-owner-4711-${PROBE}@leak.test`;
const SECRET_JID = '919999911111@s.whatsapp.net';

const clientId = randomUUID();
const instanceId = randomUUID();
const ownerUserId = randomUUID();
let staffId = '';
let accessToken = '';
let jobKey: { id: string; createdAt: string } | undefined;

/** Seeds one tenant carrying every kind of data an admin projection must never expose. */
async function seedLeakProbeTenant(): Promise<void> {
  const client = await handles.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)`, [
      ownerUserId,
      SECRET_OWNER_NAME,
      SECRET_OWNER_EMAIL,
    ]);
    await client.query(
      `INSERT INTO clients (id, company_name, slug, status, owner_user_id, plan_id)
       VALUES ($1, $2, $3, 'active', $4,
               (SELECT id FROM plans WHERE is_default LIMIT 1))`,
      [clientId, `Probe Co ${PROBE}`, `probe-co-${PROBE}`, ownerUserId],
    );
    await client.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, phone_e164, owner_jid, health_state, desired_state)
       VALUES ($1, $2, $3, $4, $5, 'connected', 'online')`,
      [instanceId, clientId, SECRET_LABEL, SECRET_PHONE, SECRET_JID],
    );
    await client.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, max_rate_minor)
       VALUES ($1, 500000, 25)`,
      [clientId],
    );
    await client.query(
      `INSERT INTO client_pricing (client_id, price_list_key)
       VALUES ($1, (SELECT key FROM price_lists LIMIT 1))`,
      [clientId],
    );
    await client.query(
      `INSERT INTO wallet_ledger
         (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, reason, external_ref)
       VALUES ($1, 1, 'topup_manual', 500000, 500000, 'staff', $2, $3)`,
      [clientId, `ledger reason ${SECRET_UTR}`, SECRET_UTR],
    );
    await client.query(
      `INSERT INTO topup_requests (client_id, amount_minor, method, external_ref, status)
       VALUES ($1, 250000, 'upi', $2, 'pending')`,
      [clientId, SECRET_UTR],
    );
    const job = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, recipient_jid, recipient_e164, payload, payload_kind,
          priority, priority_rank, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'text', 'normal', 50, 'queued')
       RETURNING id::text AS id, created_at`,
      [clientId, instanceId, SECRET_JID, SECRET_PHONE, JSON.stringify({ text: SECRET_BODY })],
    );
    jobKey = {
      id: job.rows[0]!.id,
      createdAt: job.rows[0]!.created_at.toISOString(),
    };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  handles = await buildTestAdminApp();
  await seedLeakProbeTenant();

  const staff = await seedStaffUser(handles.pool, {
    role: 'superadmin',
    emailPrefix: `probe-${PROBE}`,
  });
  staffId = staff.staffId;
  const loggedIn = await handles.app.inject({
    method: 'POST',
    url: '/admin/v1/auth/login',
    payload: {
      email: staff.email,
      password: staff.password,
      totpCode: await totpCodeFor(staff.totpSecret, handles.clock.current),
    },
  });
  accessToken = JSON.parse(loggedIn.body).data.accessToken as string;
});

afterAll(async () => {
  // Cleanup runs as the POOL OWNER, not `wp_admin_app` - that role has no
  // DELETE grant anywhere, which is precisely the property under test.
  const client = await handles.pool.connect();
  try {
    for (const sql of [
      `DELETE FROM message_jobs WHERE client_id = $1`,
      `DELETE FROM topup_requests WHERE client_id = $1`,
      `DELETE FROM wallet_ledger WHERE client_id = $1`,
      `DELETE FROM client_pricing WHERE client_id = $1`,
      `DELETE FROM wallet_accounts WHERE client_id = $1`,
      `DELETE FROM instance_lease_state WHERE client_id = $1`,
      `DELETE FROM instance_pacing_state WHERE client_id = $1`,
      `DELETE FROM whatsapp_instances WHERE client_id = $1`,
      `DELETE FROM audit_logs WHERE client_id = $1`,
      `DELETE FROM clients WHERE id = $1`,
    ]) {
      await client.query(sql, [clientId]);
    }
    await client.query(`DELETE FROM users WHERE id = $1`, [ownerUserId]);
    if (staffId) {
      await client.query(`DELETE FROM staff_sessions WHERE staff_id = $1`, [staffId]);
      await client.query(`DELETE FROM audit_logs WHERE actor_staff_id = $1`, [staffId]);
      await client.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
    }
  } finally {
    client.release();
  }
  await handles.close();
});

async function countAuditRows(requestId: string): Promise<number> {
  return withStaffRoleTx(handles.pool, async (db) => {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE request_id = $1 AND action = 'platform.read'`,
      [requestId],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

const REGISTERED_KEY = 'admin/backend/src/modules/plans/plans.read.ts:listPlans';

describe('platformRead transactional audit', () => {
  it('every_platform_read_writes_an_audit_row_in_the_same_transaction', async () => {
    const okRequestId = `probe-ok-${PROBE}`;
    const ctx = { staffId, requestId: okRequestId, ip: '127.0.0.1' };

    // (a) A read that RETURNS leaves exactly one audit row for its requestId.
    const value = await platformRead(
      handles.read,
      ctx,
      { key: REGISTERED_KEY, reason: 'audit-transaction probe' },
      async (db) => {
        const result = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM plans`);
        return result.rows[0]!.n;
      },
    );
    expect(Number(value)).toBeGreaterThan(0);
    expect(await countAuditRows(okRequestId)).toBe(1);

    // (b) A read whose `fn` THROWS leaves ZERO audit rows - the audit insert
    // rolls back with it, so staff cannot probe and leave a clean trail by
    // making the query fail. The original error still surfaces.
    const failRequestId = `probe-fail-${PROBE}`;
    await expect(
      platformRead(
        handles.read,
        { ...ctx, requestId: failRequestId },
        { key: REGISTERED_KEY, reason: 'rollback probe' },
        async () => {
          throw new Error('probe failure inside fn');
        },
      ),
    ).rejects.toThrow('probe failure inside fn');
    expect(await countAuditRows(failRequestId)).toBe(0);

    // (c) An UNREGISTERED key throws BEFORE pool.connect() is called at all.
    const connectSpy = vi.spyOn(handles.pool, 'connect');
    connectSpy.mockClear();
    await expect(
      platformRead(
        { ...handles.read, pool: handles.pool },
        { ...ctx, requestId: `probe-unreg-${PROBE}` },
        {
          key: 'admin/backend/src/modules/clients/clients.read.ts:notARegisteredRead',
          reason: 'x',
        },
        async () => 'never runs',
      ),
    ).rejects.toBeInstanceOf(UnregisteredPlatformReadError);
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });
});

describe('admin read projections', () => {
  it('admin_projections_contain_no_phone_body_name_or_external_ref', async () => {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'x-staff-reason': 'projection leak probe',
    };
    const urls = [
      `/admin/v1/clients?limit=100&q=${PROBE}`,
      `/admin/v1/clients/${clientId}`,
      `/admin/v1/instances?clientId=${clientId}&limit=100`,
      '/admin/v1/queue/summary',
      `/admin/v1/clients/${clientId}/wallet/ledger?limit=100`,
      '/admin/v1/topups?status=pending&limit=100',
      `/admin/v1/audit?clientId=${clientId}&limit=100`,
      '/admin/v1/plans',
    ];

    for (const url of urls) {
      const response = await handles.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, `${url} -> ${response.body}`).toBe(200);

      // (1) No response KEY may be a forbidden field name.
      expect(findForbiddenKeys(JSON.parse(response.body)), `${url} exposed forbidden keys`).toEqual(
        [],
      );

      // (2) No seeded secret VALUE may appear anywhere in the raw body -
      // this catches a leak that renamed the field to something innocuous.
      for (const secret of [
        SECRET_PHONE,
        SECRET_LABEL,
        SECRET_BODY,
        SECRET_UTR,
        SECRET_OWNER_NAME,
        SECRET_OWNER_EMAIL,
        SECRET_JID,
      ]) {
        expect(response.body.includes(secret), `${url} leaked "${secret}"`).toBe(false);
      }
    }

    // Sanity: the probe data really is there to be leaked - otherwise this
    // test would pass vacuously against an empty tenant.
    expect(jobKey).toBeDefined();
    const detail = await handles.app.inject({
      method: 'GET',
      url: `/admin/v1/clients/${clientId}`,
      headers,
    });
    const body = JSON.parse(detail.body).data;
    expect(body.id).toBe(clientId);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0].queueDepth).toBe(1);
  });
});
