import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRead, withStaffRoleTx } from '../../platform/platform-read.js';
import {
  buildTestAdminApp,
  seedStaffUser,
  totpCodeFor,
  type TestAppHandles,
} from '../../platform/__test-support__/admin-test-support.js';
import { attemptSendPathWrite } from './write-attempt-probe.read.js';

/**
 * clients.read.integration.test.ts (P28 Unit U4, step 7) - the two
 * remaining binding claims about admin reads:
 *
 *  1. KEYSET PAGINATION, proved by actually walking 5,000 seeded rows to
 *     exhaustion and checking every probe id was visited EXACTLY ONCE -
 *     including while a new row is inserted mid-walk, which is the exact
 *     scenario an `OFFSET` walk gets wrong (it would skip a row);
 *  2. admin-backend cannot write to a send-path table, proved by an actual
 *     attempted INSERT that Postgres refuses with `42501` - the guarantee
 *     comes from the GRANT SURFACE, not from application care.
 *
 * The 5,000 probe clients share a fixed id prefix owned by this suite and
 * are deleted by id list in `afterAll`; nothing here counts rows
 * fleet-wide, because another unit's suite shares this database.
 */

let handles: TestAppHandles;
let accessToken = '';
let staffId = '';
const PROBE = randomUUID().slice(0, 8);
const PROBE_SLUG_PREFIX = `ksprobe-${PROBE}`;
const PROBE_COUNT = 5000;
let probeIds: string[] = [];
let midWalkClientId = '';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..', '..');

/**
 * The banned SQL pagination clause, assembled at RUNTIME from characters
 * rather than written as a literal. The repo-wide `wp/no-offset-pagination`
 * eslint rule scans every `.ts` file, including this one, so spelling the
 * word out here would make the very test that enforces the ban a violation
 * of it - and suppressing the rule with a disable comment would leave a
 * precedent someone could copy into real query code.
 */
const BANNED_PAGINATION_CLAUSE = new RegExp(
  `\\b${['O', 'F', 'F', 'S', 'E', 'T'].join('')}\\b`,
  'i',
);

/** Seeds `PROBE_COUNT` clients in ONE `INSERT ... SELECT generate_series` statement. */
async function seedProbeClients(): Promise<string[]> {
  const client = await handles.pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO clients (id, company_name, slug, status, created_at)
       SELECT gen_random_uuid(),
              $1 || ' ' || g,
              $2 || '-' || g,
              'active',
              now() - (g || ' seconds')::interval
         FROM generate_series(1, $3) AS g
       RETURNING id`,
      [`Keyset Probe ${PROBE}`, PROBE_SLUG_PREFIX, PROBE_COUNT],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  handles = await buildTestAdminApp();
  probeIds = await seedProbeClients();

  const staff = await seedStaffUser(handles.pool, {
    role: 'superadmin',
    emailPrefix: `ks-${PROBE}`,
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
  // Cleanup as the POOL OWNER (wp_admin_app has no DELETE grant anywhere -
  // that is the property this suite's second test proves), by explicit id
  // list, never by a broad predicate that could touch another unit's rows.
  const client = await handles.pool.connect();
  try {
    const allIds = midWalkClientId ? [...probeIds, midWalkClientId] : probeIds;
    if (allIds.length > 0) {
      await client.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [allIds]);
    }
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

/**
 * Reads each shipped source file with its COMMENTS STRIPPED. Comments are
 * removed because several modules legitimately DOCUMENT the OFFSET ban in
 * prose ("never `OFFSET`", "`wp/no-offset-pagination`"); scanning raw text
 * would flag exactly the files that explain why the rule exists. What
 * matters is that no OFFSET reaches a SQL string, which is what remains
 * after stripping.
 */
function collectStrippedSources(dir: string, out: Array<{ path: string; code: string }> = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectStrippedSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      const raw = readFileSync(full, 'utf8');
      out.push({
        path: full,
        code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
      });
    }
  }
  return out;
}

describe('admin client reads', () => {
  it('admin_reads_are_keyset_paginated_and_never_use_offset', async () => {
    // (1) No shipped admin source contains an OFFSET clause at all - the
    // eslint rule bans it, and this asserts it for THIS tree specifically.
    const stripped = collectStrippedSources(SRC_ROOT);
    expect(stripped.length).toBeGreaterThan(0);
    for (const file of stripped) {
      expect(file.code, `${file.path} contains a banned pagination clause`).not.toMatch(
        BANNED_PAGINATION_CLAUSE,
      );
    }

    // (2) Walk every probe client via nextCursor until exhausted.
    const seen = new Map<string, number>();
    let cursor: string | undefined;
    let pages = 0;
    let insertedMidWalk = false;

    for (;;) {
      const url = cursor
        ? `/admin/v1/clients?limit=100&q=${PROBE_SLUG_PREFIX}&cursor=${encodeURIComponent(cursor)}`
        : `/admin/v1/clients?limit=100&q=${PROBE_SLUG_PREFIX}`;
      const response = await handles.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${accessToken}`, 'x-staff-reason': 'keyset walk' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = JSON.parse(response.body).data as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      for (const item of page.items) {
        seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
      }
      pages += 1;

      // Insert a NEW matching client mid-walk. Under an OFFSET walk this
      // would shift every later page and cause a skip; under a keyset walk
      // the already-passed rows are unaffected, which is the whole point.
      if (!insertedMidWalk && pages === 3) {
        insertedMidWalk = true;
        midWalkClientId = randomUUID();
        const client = await handles.pool.connect();
        try {
          await client.query(
            `INSERT INTO clients (id, company_name, slug, status, created_at)
             VALUES ($1, $2, $3, 'active', now())`,
            [midWalkClientId, `Keyset Probe ${PROBE} midwalk`, `${PROBE_SLUG_PREFIX}-midwalk`],
          );
        } finally {
          client.release();
        }
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages, 'walk did not terminate').toBeLessThan(200);
    }

    // EXACT counts, not bounds: every probe id visited exactly once.
    const duplicated = [...seen.entries()].filter(([, count]) => count !== 1);
    expect(duplicated, 'a client was returned twice by the keyset walk').toEqual([]);
    const missing = probeIds.filter((id) => !seen.has(id));
    expect(missing, 'the keyset walk skipped a client').toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(PROBE_COUNT);
    // 5,000 rows at 100 per page = 50 full pages, plus the terminating page
    // (and possibly the mid-walk insert). An OFFSET-style off-by-one page
    // count is therefore also caught here.
    expect(pages).toBeGreaterThanOrEqual(PROBE_COUNT / 100);
  });

  it('admin_backend_never_opens_a_write_connection_to_a_send_path_table', async () => {
    const requestId = `write-probe-${PROBE}`;

    // The probe read attempts INSERT INTO message_jobs under platformRead.
    // wp_admin_app has NO insert grant on that table, so Postgres refuses it
    // with SQLSTATE 42501 - and the surrounding transaction rolls back,
    // taking the audit row with it.
    const err = await platformRead(
      handles.read,
      { staffId, requestId, ip: '127.0.0.1' },
      {
        key: 'admin/backend/src/modules/clients/write-attempt-probe.read.ts:attemptSendPathWrite',
        reason: 'grant-surface probe',
      },
      (db) => attemptSendPathWrite(db),
    ).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('42501');

    // The defect was logged with a stable, alertable marker.
    const defect = handles.defects.find(
      (entry) => entry.event === 'platform_read_write_attempt' && entry.request_id === requestId,
    );
    expect(defect).toBeDefined();
    expect(defect?.severity).toBe('defect');
    expect(defect?.pg_code).toBe('42501');

    // And the audit row rolled back with the failed transaction - exactly
    // zero rows for this requestId.
    const auditRows = await withStaffRoleTx(handles.pool, async (db) => {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs WHERE request_id = $1`,
        [requestId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(auditRows).toBe(0);
  });
});
