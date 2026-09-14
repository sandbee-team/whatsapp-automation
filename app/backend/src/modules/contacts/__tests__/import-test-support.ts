import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createPool, TenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { createFsObjectStore } from '../../../platform/storage/object-store.js';
import type { ObjectStore } from '../../../platform/storage/object-store.js';
import { runOneContactImportSweep } from '../import-runner.js';
import { createContactImport, getContactImport, type ContactImportRow } from '../import.repo.js';
import type { ImportMapping } from '../import-upload.js';

/**
 * import-test-support.ts (P20 Unit U5, step 5/6) - shared, non-test fixture
 * machinery for `attestation.integration.test.ts` / `import.integration.
 * test.ts`. Lives under `__tests__/` so the tenant-scope guard's seed/
 * cleanup exemption covers its raw INSERTs (same convention as
 * `engine/queue/__tests__/queue-send-test-helpers.ts`'s own header) and so
 * vitest's `include` glob never picks it up as its own suite.
 *
 * The metrics-stub and byte-counting-store helpers
 * (`noOpMetrics`/`recordingMetrics`/`wrapCountingStore`) live in the sibling
 * `import-test-support-metrics.ts`, split out purely for this file's own
 * max-lines cap - re-exported below so callers still have one import
 * surface.
 */

export { noOpMetrics, recordingMetrics, wrapCountingStore } from './import-test-support-metrics.js';

export type TestPool = ReturnType<typeof createPool>;

/** Inserts a minimal seed client + owning user + plan (with `max_contacts`), returns their ids. */
export async function seedClientWithPlan(
  pool: TestPool,
  opts: { label: string; maxContacts?: number },
): Promise<{ clientId: string; userId: string; planId: string }> {
  const suffix = `${opts.label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientId = randomUUID();
  const userId = randomUUID();
  const planId = randomUUID();

  await pool.query(`INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)`, [
    userId,
    `Import Test Actor ${suffix}`,
    `import-${suffix}@example.test`,
  ]);
  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status, country_code) VALUES ($1, $2, $3, 'active', 'IN')`,
    [clientId, `Import Test Client ${suffix}`, `import-test-${suffix}`],
  );
  await pool.query(`INSERT INTO plans (id, name) VALUES ($1, $2)`, [
    planId,
    `Import Test Plan ${suffix}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances, max_contacts)
     VALUES ($1, 5, 5, $2)`,
    [planId, opts.maxContacts ?? 25000],
  );
  await pool.query(`UPDATE clients SET plan_id = $1 WHERE id = $2 -- client_id = id = $2`, [
    planId,
    clientId,
  ]);

  return { clientId, userId, planId };
}

/** One `FileKeyProvider` mounted for `'optout-pepper'` only, backed by a fresh temp key ring. */
export function buildTestKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-import-test-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0d).toString('base64');
  writeFileSync(
    path,
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
  return new FileKeyProvider({ ringPath: path, mountedPurposes: ['optout-pepper'] });
}

/** A fresh `fs` object store rooted at a temp dir, for one test file's lifetime. */
export function buildTestObjectStore(): ObjectStore {
  const rootDir = mkdtempSync(join(tmpdir(), 'wp-import-test-store-'));
  return createFsObjectStore({ rootDir });
}

/** Uploads `csvText` as one import object for `clientId`, returning its storage key. */
export async function uploadCsvObject(
  objectStore: ObjectStore,
  clientId: string,
  csvText: string,
  now = new Date('2026-01-15T00:00:00.000Z'),
): Promise<{ key: string; bytes: number }> {
  const { Readable } = await import('node:stream');
  return objectStore.put({
    clientId,
    kind: 'imports',
    body: Readable.from([csvText]),
    contentType: 'text/csv',
    maxBytes: 32 * 1024 * 1024,
    now,
  });
}

/**
 * Deterministic CSV generator: header `phone,name,city`, unique valid Indian
 * mobiles `+919` + 9 digits, indexed from 0. `paddingCharsPerRow` (default 0)
 * appends filler text to the (unmapped, ignored) `city` column so the total
 * file size can be grown independently of row count - needed by the
 * bounded-memory test, where Node's fixed ~128 KiB stream read-ahead must
 * stay a SMALL fraction of the file, not merely less than it.
 */
export function generateCsv(
  rowCount: number,
  opts?: { startIndex?: number; paddingCharsPerRow?: number },
): string {
  const start = opts?.startIndex ?? 0;
  const padding = opts?.paddingCharsPerRow ? 'x'.repeat(opts.paddingCharsPerRow) : '';
  const lines = ['phone,name,city'];
  for (let i = 0; i < rowCount; i += 1) {
    const index = start + i;
    lines.push(`${phoneForIndex(index)},Name ${index},City ${index}${padding}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** The deterministic phone number the generator assigns to `index` - a valid Indian mobile, `+91` then a leading `9` then 9 digits. */
export function phoneForIndex(index: number): string {
  const digits = String(index).padStart(9, '0').slice(-9);
  return `+919${digits}`;
}

/**
 * Like `generateCsv`, but prefixed with a UTF-8 BOM and with every `nth`
 * record's `name` field a QUOTED value containing an embedded CRLF (e.g.
 * `"Rao,\r\nKiran"`) - the row-cursor-desynchronisation regression case
 * (P20 C1 M4): `csv-parse`'s `from` counts RECORDS post-header, immune to
 * an embedded newline inside a quoted field, unlike a naive line-count
 * resume point would be.
 */
export function generateCsvWithQuotedNewlines(
  rowCount: number,
  nth: number,
  opts?: { startIndex?: number },
): string {
  const start = opts?.startIndex ?? 0;
  const lines = ['phone,name,city'];
  for (let i = 0; i < rowCount; i += 1) {
    const index = start + i;
    const recordNo = i + 1; // 1-indexed, matches readImportBatch's recordNo
    const name = recordNo % nth === 0 ? `"Rao,\r\nKiran ${index}"` : `Name ${index}`;
    lines.push(`${phoneForIndex(index)},${name},City ${index}`);
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Creates+attests one `contact_imports` row for `csvText`, uploaded fresh to `objectStore`. */
export async function createAndAttestImport(
  tenantDb: TenantDb,
  objectStore: ObjectStore,
  input: {
    clientId: string;
    userId: string;
    csvText: string;
    mapping?: ImportMapping;
    applyTagIds?: string[];
  },
): Promise<ContactImportRow> {
  const { key } = await uploadCsvObject(objectStore, input.clientId, input.csvText);
  const mapping = input.mapping ?? { phone: 'phone', name: 'name' };
  return tenantDb.withTenant(input.clientId, (tx) =>
    createContactImport(tx, {
      clientId: input.clientId,
      filename: 'contacts.csv',
      storageKey: key,
      mapping,
      mappingColumns: ['phone', 'name', 'city'],
      defaultCountry: 'IN',
      applyTagIds: input.applyTagIds ?? [],
      attestationText: 'Collected via in-store signup forms, opted in for WhatsApp updates.',
      attestedByUserId: input.userId,
      now: new Date('2026-01-15T00:00:00.000Z'),
    }),
  );
}

export interface SweepDeps {
  pool: TestPool;
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
  objectStore: ObjectStore;
  metrics: Parameters<typeof runOneContactImportSweep>[0]['metrics'];
  hooks?: Parameters<typeof runOneContactImportSweep>[0]['hooks'];
  batchSize?: number;
}

/**
 * Runs sweeps until `importId` reaches a terminal status
 * (`done`/`failed`/`cancelled`), or `maxSweeps` is exceeded. A crash
 * injected via `deps.hooks` is caught and swallowed here (never inside
 * `runOneContactImportSweep` itself - a REAL crash just kills the process;
 * this loop stands in for "the process died mid-batch and a fresh one
 * picked the sweep back up"), so the loop keeps going past an injected
 * throw exactly as a real restarted worker would.
 */
export async function sweepUntilDone(
  deps: SweepDeps,
  clientId: string,
  importId: string,
  maxSweeps = 100,
): Promise<{ row: ContactImportRow; sweeps: number }> {
  for (let i = 0; i < maxSweeps; i += 1) {
    try {
      await runOneContactImportSweep({
        pool: deps.pool,
        tenantDb: deps.tenantDb,
        keyProvider: deps.keyProvider,
        objectStore: deps.objectStore,
        metrics: deps.metrics,
        hooks: deps.hooks,
        batchSize: deps.batchSize,
        maxClientsPerSweep: 50,
      });
    } catch {
      // An injected crash (deps.hooks) - swallow it here and let the loop
      // re-sweep, standing in for a fresh worker process picking the
      // durable job back up from its last-committed cursor_row.
    }
    const row = await deps.tenantDb.withTenant(clientId, (tx) =>
      getContactImport(tx, clientId, importId),
    );
    if (row && row.status !== 'uploaded' && row.status !== 'importing') {
      return { row, sweeps: i + 1 };
    }
  }
  const row = await deps.tenantDb.withTenant(clientId, (tx) =>
    getContactImport(tx, clientId, importId),
  );
  if (!row) throw new Error('sweepUntilDone: import row disappeared');
  return { row, sweeps: maxSweeps };
}

/** Reverse-FK-order cleanup for probe clients created by `seedClientWithPlan`. */
export async function cleanupImportProbeClients(
  pool: TestPool,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM contact_tag_links WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM contact_tags WHERE client_id = ANY($1)', [clientIds]);
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
