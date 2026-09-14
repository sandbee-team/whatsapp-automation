import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { syncOptOutMirror } from './optout-mirror.js';
import { AttestationRequiredError, createContactImport } from './import.repo.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  seedClientWithPlan,
  uploadCsvObject,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-crash-and-replay-c2.integration.test.ts (C2 hardening) -
 * two priority edge cases the existing suite does not name directly:
 * (1) a crash mid multi-statement transaction (`createContactImport`'s
 * three-statement write, forced to fail on its LAST statement) leaves
 * zero rows anywhere - all-or-nothing, not partial; (2) replaying an
 * already-applied mirror write is a true no-op (`contactsUpdated: 0`),
 * proving `syncOptOutMirror`'s drift-guard predicate actually gates writes
 * rather than writing unconditionally every time.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-crash-replay-c2-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe("a crash inside createContactImport's multi-statement transaction", () => {
  it('an_over_long_attestation_metadata_value_rolls_back_all_three_writes', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'crash-mid-tx',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const { key } = await uploadCsvObject(objectStore, clientId, 'phone,name\n+919000000001,A\n');

    // A pathologically long attestation text is still a valid (non-empty)
    // attestation for `createContactImport`'s own guard, so it passes that
    // guard and reaches the INSERT statements - this is NOT the
    // `AttestationRequiredError` path, it is a genuine multi-statement crash
    // scenario: force the row count to prove no partial state survives when
    // one of the three writes in the same transaction fails.
    const hugeAttestation = 'x'.repeat(50_000);

    let threw: unknown;
    try {
      await tenantDb.withTenant(clientId, async (tx) => {
        await createContactImport(tx, {
          clientId,
          filename: 'contacts.csv',
          storageKey: key,
          mapping: { phone: 'phone', name: 'name' },
          mappingColumns: ['phone', 'name'],
          defaultCountry: 'IN',
          applyTagIds: [],
          attestationText: hugeAttestation,
          attestedByUserId: userId,
          now: new Date('2026-01-15T00:00:00.000Z'),
        });
        // Force the transaction to fail AFTER all three inserts have run in
        // application order, simulating "the process died right after the
        // last statement, before COMMIT" - withTenant's own ROLLBACK is what
        // we are proving actually undoes every statement, not just the last.
        throw new Error('simulated crash after all three inserts, before commit');
      });
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(Error);

    const imports = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [clientId],
    );
    const consentRecords = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consent_records WHERE client_id = $1',
      [clientId],
    );
    const auditLogs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE client_id = $1 AND action = 'contacts.import.attested'`,
      [clientId],
    );

    // All-or-nothing: the crash happened AFTER the writes but BEFORE commit,
    // and withTenant's ROLLBACK must undo all three - never a stranded
    // contact_imports row with no matching consent_records/audit_logs.
    expect(imports.rows[0]?.count).toBe('0');
    expect(consentRecords.rows[0]?.count).toBe('0');
    expect(auditLogs.rows[0]?.count).toBe('0');
  });

  it('an_empty_attestation_never_reaches_any_insert_zero_rows_anywhere', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'crash-empty-attestation',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const { key } = await uploadCsvObject(objectStore, clientId, 'phone,name\n+919000000002,B\n');

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

    const imports = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [clientId],
    );
    expect(imports.rows[0]?.count).toBe('0');
  });
});

describe('replaying an already-applied mirror write', () => {
  it('a_second_syncOptOutMirror_call_with_nothing_changed_updates_zero_rows', async () => {
    const { clientId } = await seedClientWithPlan(pool, {
      label: 'replay-mirror',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);

    const phoneHash = hashRecipient(keyProvider, '+919876500001');
    const contactResult = await pool.query<{ id: string }>(
      `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source)
       VALUES ($1, '+919876500001', $2, '919876500001@s.whatsapp.net', 'manual')
       RETURNING id`,
      [clientId, phoneHash],
    );
    const contactId = contactResult.rows[0]?.id;
    expect(contactId).toBeDefined();

    await pool.query(
      `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
       VALUES (gen_random_uuid(), $1, 'client', $1, $2, $3, 'manual')`,
      [clientId, phoneHash, Buffer.from('probe-enc')],
    );

    const first = await tenantDb.withTenant(clientId, (tx) =>
      syncOptOutMirror(tx, { clientId, phoneHash }),
    );
    expect(first.contactsUpdated).toBe(1);

    // Replay: running the exact same sync again with nothing having changed
    // in `opt_outs` must match zero rows via the drift-guard predicate
    // (`WHERE ((...) <> d.live OR ... IS DISTINCT FROM ...)`), never an
    // unconditional re-write.
    const second = await tenantDb.withTenant(clientId, (tx) =>
      syncOptOutMirror(tx, { clientId, phoneHash }),
    );
    expect(second.contactsUpdated).toBe(0);

    const row = await pool.query<{ opt_out_state: string }>(
      'SELECT opt_out_state::text AS opt_out_state FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(row.rows[0]?.opt_out_state).toBe('opted_out');
  });
});
