import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { createPool } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { createFsObjectStore } from '../../../platform/storage/object-store.js';
import type { ObjectStore } from '../../../platform/storage/object-store.js';

/**
 * suite-b-test-support.ts (P20 Unit U8, step 9's suite B) - shared, non-test
 * fixture machinery for `suite-b-contacts.integration.test.ts`. Lives under
 * `__tests__/` so the tenant-scope guard's seed/cleanup exemption covers its
 * raw INSERTs (same convention as `mirror-test-support.ts`/`import-test-
 * support.ts`), and so vitest's `include` glob never picks it up as its own
 * suite (no `.test.ts` suffix).
 */

export type TestPool = ReturnType<typeof createPool>;

/**
 * A `FileKeyProvider` mounting BOTH `'optout-pepper'` (hashing) AND
 * `'tenant-secrets'` (the `sealPhoneForOptOut` call `recordOptOut`'s callers
 * make, e.g. `detectInboundOptOut`) - the inbound-opt-out case in this suite
 * exercises the real seal path end to end, unlike `phone-hash.test.ts#make
 * Provider`/`import-test-support.ts#buildTestKeyProvider` which mount only
 * `optout-pepper` because their callers never seal.
 */
export function buildSuiteBPepperProvider(): KeyProvider {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp-suite-b-ring-'));
  const ringPath = path.join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0e).toString('base64');
  writeFileSync(
    ringPath,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper', 'tenant-secrets'] });
}

/** A fresh `fs` object store rooted at a temp dir, for one test file's lifetime. */
export async function buildSuiteBObjectStore(): Promise<{ store: ObjectStore; rootDir: string }> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'wp-suite-b-store-'));
  return { store: createFsObjectStore({ rootDir }), rootDir };
}

/** Inserts a minimal seed client + owning user + plan (with `max_contacts`), returns their ids - same shape as `import-test-support.ts#seedClientWithPlan`. */
export async function seedSuiteBClient(
  pool: TestPool,
  label: string,
): Promise<{ clientId: string; userId: string; planId: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientId = randomUUID();
  const userId = randomUUID();
  const planId = randomUUID();

  await pool.query(`INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)`, [
    userId,
    `Suite B Actor ${suffix}`,
    `suite-b-${suffix}@example.test`,
  ]);
  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status, country_code) VALUES ($1, $2, $3, 'active', 'IN')`,
    [clientId, `Suite B Client ${suffix}`, `suite-b-${suffix}`],
  );
  await pool.query(`INSERT INTO plans (id, name) VALUES ($1, $2)`, [
    planId,
    `Suite B Plan ${suffix}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances, max_contacts)
     VALUES ($1, 5, 5, 25000)`,
    [planId],
  );
  await pool.query(`UPDATE clients SET plan_id = $1 WHERE id = $2 -- client_id = id = $2`, [
    planId,
    clientId,
  ]);

  return { clientId, userId, planId };
}

/** A valid Indian mobile, deterministic per `(seedLabel, index)` so two tenants can share IDENTICAL phone numbers on demand. */
export function suiteBPhone(index: number): string {
  const digits = String(index).padStart(9, '0').slice(-9);
  return `+919${digits}`;
}

/** Deterministic CSV generator: header `phone,name`, `rowCount` rows starting at `startIndex`. */
export function suiteBCsv(rowCount: number, startIndex = 0): string {
  const lines = ['phone,name'];
  for (let i = 0; i < rowCount; i += 1) {
    const index = startIndex + i;
    lines.push(`${suiteBPhone(index)},Name ${index}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** Uploads one CSV import object for `clientId`, returning its storage key + bytes. */
export async function uploadSuiteBCsv(
  objectStore: ObjectStore,
  clientId: string,
  csvText: string,
  now = new Date('2026-01-15T00:00:00.000Z'),
): Promise<{ key: string; bytes: number }> {
  return objectStore.put({
    clientId,
    kind: 'imports',
    body: Readable.from([csvText]),
    contentType: 'text/csv',
    maxBytes: 32 * 1024 * 1024,
    now,
  });
}

/** Inserts one `contact_imports` row directly (bypassing `createContactImport`'s attestation/consent writes - this suite tests the SWEEPS, not the create path), plus `errorRowCount` `contact_import_errors` rows, backdating `created_at` and the object's mtime by `ageInDays`. */
export async function seedSuiteBImportWithObject(
  pool: TestPool,
  objectStore: ObjectStore,
  rootDir: string,
  clientId: string,
  attestedByUserId: string,
  ageInDays: number,
  errorRowCount: number,
): Promise<{ importId: string; key: string }> {
  const createdAt = new Date(Date.now() - ageInDays * 86_400_000);
  const importId = randomUUID();

  const stored = await objectStore.put({
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
      `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason)
       VALUES ($1, $2, $3, 'invalid phone')`,
      [importId, clientId, rowNo],
    );
  }

  return { importId, key: stored.key };
}

/** Inserts one minimal `contacts` row directly, returning its id - same shape as `mirror-test-support.ts#seedContact`. */
export async function insertSuiteBContact(
  pool: TestPool,
  clientId: string,
  phoneHash: Buffer,
  optOutState: 'none' | 'opted_out',
): Promise<string> {
  const phoneE164 = `+1555${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source, opt_out_state)
     VALUES ($1, $2, $3, $4, 'manual', $5)
     RETURNING id`,
    [clientId, phoneE164, phoneHash, `${phoneE164.replace('+', '')}@s.whatsapp.net`, optOutState],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertSuiteBContact: no row returned');
  return id;
}

/** Inserts one live (unrestored) `opt_outs` row directly - same shape as `mirror-test-support.ts#seedLiveOptOut`. */
export async function insertSuiteBLiveOptOut(
  pool: TestPool,
  clientId: string,
  phoneHash: Buffer,
  createdAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source, created_at)
     VALUES ($1, $2, 'client', $2, $3, $4, 'manual', $5)`,
    [randomUUID(), clientId, phoneHash, Buffer.from('probe-phone-enc'), createdAt],
  );
}

/** Reverse-FK-order cleanup for probe clients created by `seedSuiteBClient`. */
export async function cleanupSuiteBClients(pool: TestPool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM contact_tag_links WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM contact_import_errors WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM contact_imports WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM consent_records WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [clientIds]);
  const planIds = await pool.query<{ plan_id: string }>(
    'SELECT plan_id FROM clients WHERE id = ANY($1) AND plan_id IS NOT NULL',
    [clientIds],
  );
  await pool.query('UPDATE clients SET plan_id = NULL WHERE id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
  const planIdList = planIds.rows.map((r) => r.plan_id);
  if (planIdList.length > 0) {
    await pool.query('DELETE FROM plan_limits WHERE plan_id = ANY($1)', [planIdList]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1)', [planIdList]);
  }
}
