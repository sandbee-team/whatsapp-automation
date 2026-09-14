import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFsObjectStore } from '../../platform/storage/object-store.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import { runOneImportRetentionPurge } from './retention-purge.js';
import { restoreOptOut } from '../pacing/optout/restore.js';
import { syncOptOutMirror } from './optout-mirror.js';
import {
  cleanupMirrorProbeClients,
  seedContact,
  seedLiveOptOut,
  seedProbeClient,
  type TestPool,
} from './__tests__/mirror-test-support.js';

/**
 * mirror-and-purge-boundaries-c2.integration.test.ts (C2 hardening) - two
 * clock-boundary and restore-path cases the C2 brief calls out: the purge
 * cutoff's exact `created_at = now - 30d` edge (kept, not purged, since the
 * comparison is `created_at < cutoff`, strictly less-than), and
 * `restoreOptOut` when the contact ALSO carries a still-live opt-out at a
 * different scope (any-scope mirror semantics).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];
let rootDir: string;
let store: ObjectStore;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-mirror-purge-boundaries-c2-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-mirror-purge-boundary-'));
  store = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await cleanupMirrorProbeClients(pool, probeClientIds);
  probeClientIds = [];
  await rm(rootDir, { recursive: true, force: true });
});

async function seedImportAt(
  clientId: string,
  createdAt: Date,
  errorRowCount: number,
): Promise<{ importId: string; key: string }> {
  const importId = randomUUID();
  const attestedByUserId = randomUUID();

  const stored = await store.put({
    clientId,
    kind: 'imports',
    body: Readable.from([Buffer.from('phone\n+15550000000\n')]),
    contentType: 'text/csv',
    maxBytes: 10_000,
    now: createdAt,
    id: importId,
  });
  const absolutePath = path.join(rootDir, ...stored.key.split('/'));
  await utimes(absolutePath, createdAt, createdAt);

  await pool.query(
    `INSERT INTO contact_imports
       (id, client_id, storage_key, mapping, default_country, attestation_text,
        attested_by_user_id, attested_at, status, created_at)
     VALUES ($1, $2, $3, $4, 'IN', 'test attestation', $5, $6, 'done', $6)`,
    [
      importId,
      clientId,
      stored.key,
      JSON.stringify({ phone: 'phone' }),
      attestedByUserId,
      createdAt,
    ],
  );

  for (let rowNo = 0; rowNo < errorRowCount; rowNo += 1) {
    await pool.query(
      `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason) VALUES ($1, $2, $3, 'invalid phone')`,
      [importId, clientId, rowNo],
    );
  }

  return { importId, key: stored.key };
}

describe('the purge cutoff boundary is instant-based, exclusive of the exact cutoff', () => {
  it('created_at_exactly_now_minus_30d_is_kept_one_second_older_is_purged', async () => {
    const clientId = await seedProbeClient(pool, 'purge-boundary');
    probeClientIds.push(clientId);

    // Inject `now` explicitly as an Asia/Kolkata-offset ISO instant, so the
    // comparison is proven instant-based, not local-midnight based.
    const now = new Date('2026-09-05T12:00:00.000+05:30');
    const exactlyCutoff = new Date(now.getTime() - 30 * 86_400_000);
    const oneSecondOlder = new Date(exactlyCutoff.getTime() - 1_000);

    const keptImport = await seedImportAt(clientId, exactlyCutoff, 2);
    const purgedImport = await seedImportAt(clientId, oneSecondOlder, 2);

    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientId],
      now: () => now,
      retentionDays: 30,
    });

    // Exactly one import's error rows/object are purged (the one strictly
    // older than the cutoff) - `created_at < cutoff` is exclusive, so the
    // exactly-equal row is KEPT.
    expect(result.errorRowsDeleted).toBe(2);
    expect(result.objectsDeleted).toBe(1);

    const keptErrors = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
      [keptImport.importId],
    );
    const purgedErrors = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
      [purgedImport.importId],
    );
    expect(keptErrors.rows[0]?.count).toBe('2');
    expect(purgedErrors.rows[0]?.count).toBe('0');

    expect(await store.head(keptImport.key)).not.toBeNull();
    expect(await store.head(purgedImport.key)).toBeNull();
  });
});

describe('restoreOptOut when an instance-scope opt-out is still live', () => {
  it('the_mirror_stays_opted_out_and_opted_out_at_becomes_the_remaining_rows_created_at', async () => {
    const clientId = await seedProbeClient(pool, 'restore-any-scope');
    probeClientIds.push(clientId);

    const phoneHash = Buffer.alloc(32, 0x07);
    const contactId = await seedContact(pool, clientId, { phoneHash, optOutState: 'none' });

    const clientScopeCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    const instanceScopeCreatedAt = new Date('2026-02-01T00:00:00.000Z');
    const instanceId = randomUUID();

    const clientScopeOptOutId = await seedLiveOptOut(pool, clientId, {
      scope: 'client',
      scopeKey: clientId,
      phoneHash,
      createdAt: clientScopeCreatedAt,
    });
    await seedLiveOptOut(pool, clientId, {
      scope: 'instance',
      scopeKey: instanceId,
      phoneHash,
      createdAt: instanceScopeCreatedAt,
    });

    // Seed the mirror to its pre-restore state (any-scope: opted_out, at
    // the EARLIEST live row = the client-scope one).
    await tenantDb.withTenant(clientId, (tx) => syncOptOutMirror(tx, { clientId, phoneHash }));
    const before = await pool.query<{ opt_out_state: string; opted_out_at: Date }>(
      'SELECT opt_out_state::text AS opt_out_state, opted_out_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(before.rows[0]?.opt_out_state).toBe('opted_out');
    expect(before.rows[0]?.opted_out_at?.toISOString()).toBe(clientScopeCreatedAt.toISOString());

    const actorUserId = randomUUID();
    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      actorUserId,
      'Restore Actor',
      `restore-actor-${randomUUID()}@example.test`,
    ]);

    // Restore ONLY the client-scope row - the instance-scope row is still
    // live, so any-scope mirror semantics must keep the contact opted_out.
    await tenantDb.withTenant(clientId, (tx) =>
      restoreOptOut(
        tx,
        {
          clientId,
          optOutId: clientScopeOptOutId,
          actor: { type: 'user', userId: actorUserId },
          restoreReason: 'customer requested re-enrollment on the client scope only',
        },
        { mirror: syncOptOutMirror },
      ),
    );

    const after = await pool.query<{ opt_out_state: string; opted_out_at: Date }>(
      'SELECT opt_out_state::text AS opt_out_state, opted_out_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(after.rows[0]?.opt_out_state).toBe('opted_out');
    // opted_out_at is now the REMAINING (instance-scope) row's created_at -
    // the only still-live row for this recipient.
    expect(after.rows[0]?.opted_out_at?.toISOString()).toBe(instanceScopeCreatedAt.toISOString());

    await pool.query('DELETE FROM users WHERE id = $1', [actorUserId]);
  });
});
