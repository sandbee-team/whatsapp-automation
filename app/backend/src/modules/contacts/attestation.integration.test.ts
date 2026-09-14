import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOneContactImportSweep } from './import-runner.js';
import { AttestationRequiredError, createContactImport } from './import.repo.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  seedClientWithPlan,
  uploadCsvObject,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * attestation.integration.test.ts (P20 Unit U5, step 5) - proves the
 * import attestation gate against real Postgres: no attestation, no
 * import, ever - and the attestation write is transactional with its
 * `consent_records`/`audit_logs` companions.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-attestation-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('an import without an attestation never runs', () => {
  it('an_import_without_an_attestation_never_runs', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, { label: 'no-attest' });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const { key } = await uploadCsvObject(
      objectStore,
      clientId,
      'phone,name\n+919000000001,Alice\n',
    );

    // (a) A raw INSERT omitting the NOT NULL attestation columns fails 23502.
    await expect(
      pool.query(
        `INSERT INTO contact_imports (client_id, storage_key, mapping, default_country, status)
         VALUES ($1, $2, '{"phone":"phone"}'::jsonb, 'IN', 'uploaded')`,
        [clientId, key],
      ),
    ).rejects.toMatchObject({ code: '23502' });

    // (b) createContactImport with a whitespace-only attestation throws, and
    // leaves zero contact_imports/consent_records/audit_logs rows for this client.
    await expect(
      tenantDb.withTenant(clientId, (tx) =>
        createContactImport(tx, {
          clientId,
          filename: 'contacts.csv',
          storageKey: key,
          mapping: { phone: 'phone', name: 'name' },
          mappingColumns: ['phone', 'name'],
          defaultCountry: 'IN',
          applyTagIds: [],
          attestationText: '   ',
          attestedByUserId: userId,
          now: new Date('2026-01-15T00:00:00.000Z'),
        }),
      ),
    ).rejects.toBeInstanceOf(AttestationRequiredError);

    const importsCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [clientId],
    );
    expect(Number(importsCount.rows[0]?.count)).toBe(0);
    const consentCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consent_records WHERE client_id = $1',
      [clientId],
    );
    expect(Number(consentCount.rows[0]?.count)).toBe(0);
    const auditCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_logs WHERE client_id = $1 AND action = 'contacts.import.attested'",
      [clientId],
    );
    expect(Number(auditCount.rows[0]?.count)).toBe(0);

    // (c) With no valid import row anywhere for this client, a sweep is a clean no-op.
    const result = await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider: buildTestKeyProvider(),
      objectStore,
      metrics: {
        contactsImportedTotal: { inc: () => undefined } as never,
        contactImportRowsTotal: { inc: () => undefined } as never,
        optoutMirrorDriftTotal: { inc: () => undefined } as never,
      },
      maxClientsPerSweep: 50,
    });
    expect(result.importsTouched).toBe(0);
    const contactsCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [clientId],
    );
    expect(Number(contactsCount.rows[0]?.count)).toBe(0);
  });
});

describe('the attestation records the user and the timestamp', () => {
  it('the_attestation_records_the_user_and_the_timestamp', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, { label: 'attest-ok' });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const { key } = await uploadCsvObject(
      objectStore,
      clientId,
      'phone,name\n+919000000001,Alice\n',
    );
    const fixed = new Date('2026-02-01T10:30:00.000Z');
    const attestationText = 'Collected via in-store signup forms, opted in for WhatsApp updates.';

    const created = await tenantDb.withTenant(clientId, (tx) =>
      createContactImport(tx, {
        clientId,
        filename: 'contacts.csv',
        storageKey: key,
        mapping: { phone: 'phone', name: 'name' },
        mappingColumns: ['phone', 'name'],
        defaultCountry: 'IN',
        applyTagIds: [],
        attestationText,
        attestedByUserId: userId,
        now: fixed,
      }),
    );

    const consentRow = await pool.query<{
      basis: string;
      captured_by_user_id: string;
      evidence_ref: string;
      source_note: string;
      captured_at: Date;
    }>(
      'SELECT basis, captured_by_user_id, evidence_ref, source_note, captured_at FROM consent_records WHERE client_id = $1',
      [clientId],
    );
    expect(consentRow.rows).toHaveLength(1);
    const consent = consentRow.rows[0]!;
    expect(consent.basis).toBe('imported_with_attestation');
    expect(consent.captured_by_user_id).toBe(userId);
    expect(consent.evidence_ref).toBe(`contact_import:${created.id}`);
    expect(consent.source_note).toBe(attestationText);
    expect(consent.captured_at.toISOString()).toBe(fixed.toISOString());
    expect(created.attestedAt).toBe(fixed.toISOString());

    const auditRow = await pool.query<{
      action: string;
      actor_user_id: string;
      target_id: string;
      metadata: { source?: string } | null;
    }>(
      "SELECT action, actor_user_id, target_id, metadata FROM audit_logs WHERE client_id = $1 AND action = 'contacts.import.attested'",
      [clientId],
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0]?.actor_user_id).toBe(userId);
    expect(auditRow.rows[0]?.target_id).toBe(created.id);
    // n1: metadata is routed through the shared `filterAuditMetadata`
    // allow-list (`source`/`reason`/`code`/`acknowledgement` ONLY) - the
    // row's metadata is EXACTLY that filtered shape, never raw JSON.
    expect(auditRow.rows[0]?.metadata).toEqual({
      source: attestationText.slice(0, 200),
    });

    // SAME-TRANSACTION proof: a callback that throws AFTER creating the
    // import rolls back all three rows together.
    const { clientId: clientId2, userId: userId2 } = await seedClientWithPlan(pool, {
      label: 'attest-rollback',
    });
    createdClientIds.push(clientId2);
    const { key: key2 } = await uploadCsvObject(
      objectStore,
      clientId2,
      'phone,name\n+919000000002,Bob\n',
    );

    await expect(
      tenantDb.withTenant(clientId2, async (tx) => {
        await createContactImport(tx, {
          clientId: clientId2,
          filename: 'contacts.csv',
          storageKey: key2,
          mapping: { phone: 'phone', name: 'name' },
          mappingColumns: ['phone', 'name'],
          defaultCountry: 'IN',
          applyTagIds: [],
          attestationText: 'Some attestation text.',
          attestedByUserId: userId2,
          now: fixed,
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const rolledBackImports = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [clientId2],
    );
    expect(Number(rolledBackImports.rows[0]?.count)).toBe(0);
    const rolledBackConsent = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consent_records WHERE client_id = $1',
      [clientId2],
    );
    expect(Number(rolledBackConsent.rows[0]?.count)).toBe(0);
    const rolledBackAudit = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE client_id = $1',
      [clientId2],
    );
    expect(Number(rolledBackAudit.rows[0]?.count)).toBe(0);
  });
});
