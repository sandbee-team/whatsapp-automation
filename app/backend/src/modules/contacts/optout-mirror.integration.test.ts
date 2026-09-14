import { randomBytes, randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { recordOptOut, restoreOptOut } from '../pacing/index.js';
import {
  cleanupMirrorProbeClients,
  seedContact,
  seedProbeClient,
  type TestPool,
} from './__tests__/mirror-test-support.js';
import { syncOptOutMirror } from './optout-mirror.js';

/**
 * optout-mirror.integration.test.ts (P20 Unit U7, step 8; P20 Unit U8, step
 * 8 - appends `record_opt_out_writes_the_mirror_through_the_injected_port_
 * in_the_same_transaction`) - real-Postgres proof that `syncOptOutMirror` is
 * the mirror-only writer (design doc S2.5: same transaction as the
 * `opt_outs` insert/restore, never the gate). `runOneMirrorReconcileSweep`'s
 * own proof lives in the sibling `mirror-reconcile.integration.test.ts`
 * (split for this file's own max-lines cap - same split idiom as
 * `session-worker-discovery-wiring.ts`).
 *
 * The ORIGINAL `mirror_is_written_in_the_same_transaction_as_the_opt_out`
 * case (U7) deliberately calls `recordOptOut`/`restoreOptOut` with a NO-OP
 * mirror dep and then `syncOptOutMirror` separately at the call site, to
 * isolate `syncOptOutMirror`'s own derivation from the injected-port wiring -
 * the new U8 case below proves the INJECTED port itself.
 */

const noopMirror = async () => ({ contactsUpdated: 0 });

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-mirror-it',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupMirrorProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function contactRow(
  contactId: string,
): Promise<{ opt_out_state: string; opted_out_at: Date | null }> {
  const result = await pool.query<{ opt_out_state: string; opted_out_at: Date | null }>(
    'SELECT opt_out_state, opted_out_at FROM contacts WHERE id = $1',
    [contactId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('contactRow: no such contact');
  return row;
}

describe('syncOptOutMirror', () => {
  it('mirror_is_written_in_the_same_transaction_as_the_opt_out', async () => {
    const clientId = await seedProbeClient(pool, 'suite-mirror-tx');
    probeClientIds.push(clientId);
    const phoneHash = randomBytes(32);
    const contactId = await seedContact(pool, clientId, { phoneHash, optOutState: 'none' });

    const tenantDb = createTenantDb(pool);

    // A recordOptOut + syncOptOutMirror that then THROWS must roll back both.
    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        await recordOptOut(
          tx,
          {
            clientId,
            scope: 'client',
            scopeKey: clientId,
            phoneHash,
            phoneEnc: Buffer.from('enc'),
            source: 'manual',
          },
          { mirror: noopMirror },
        );
        await syncOptOutMirror(tx, { clientId, phoneHash });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const optOutsAfterThrow = await pool.query('SELECT 1 FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutsAfterThrow.rowCount).toBe(0);
    const afterThrow = await contactRow(contactId);
    expect(afterThrow.opt_out_state).toBe('none');
    expect(afterThrow.opted_out_at).toBeNull();

    // Repeat without the throw: both land.
    await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('enc'),
          source: 'manual',
        },
        { mirror: noopMirror },
      );
      await syncOptOutMirror(tx, { clientId, phoneHash });
    });

    const optOutRow = await pool.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    expect(optOutRow.rows).toHaveLength(1);
    const optOutId = optOutRow.rows[0]!.id;
    const createdAt = optOutRow.rows[0]!.created_at;

    const afterRecord = await contactRow(contactId);
    expect(afterRecord.opt_out_state).toBe('opted_out');
    expect(afterRecord.opted_out_at?.toISOString()).toBe(createdAt.toISOString());

    // Restore + sync in one tx.
    await tenantDb.withTenant(clientId, async (tx) => {
      await restoreOptOut(
        tx,
        {
          clientId,
          optOutId,
          actor: { type: 'user', userId: randomUUID() },
          restoreReason: 'test',
        },
        { mirror: noopMirror },
      );
      await syncOptOutMirror(tx, { clientId, phoneHash });
    });

    const afterRestore = await contactRow(contactId);
    expect(afterRestore.opt_out_state).toBe('none');
    expect(afterRestore.opted_out_at).toBeNull();

    // Instance-scope opt-out: any-scope semantics still mirror as opted_out.
    const instanceScopeKey = randomUUID();
    await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'instance',
          scopeKey: instanceScopeKey,
          phoneHash,
          phoneEnc: Buffer.from('enc'),
          source: 'manual',
        },
        { mirror: noopMirror },
      );
      await syncOptOutMirror(tx, { clientId, phoneHash });
    });

    const afterInstanceOptOut = await contactRow(contactId);
    expect(afterInstanceOptOut.opt_out_state).toBe('opted_out');

    // A second sync call with nothing changed is a no-op (idempotent).
    const repeat = await tenantDb.withTenant(clientId, (tx) =>
      syncOptOutMirror(tx, { clientId, phoneHash }),
    );
    expect(repeat.contactsUpdated).toBe(0);

    // A soft-deleted contact is never updated.
    const deletedPhoneHash = randomBytes(32);
    const deletedContactId = await seedContact(pool, clientId, {
      phoneHash: deletedPhoneHash,
      optOutState: 'none',
      deletedAt: new Date(),
    });
    await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash: deletedPhoneHash,
          phoneEnc: Buffer.from('enc'),
          source: 'manual',
        },
        { mirror: noopMirror },
      );
      const result = await syncOptOutMirror(tx, { clientId, phoneHash: deletedPhoneHash });
      expect(result.contactsUpdated).toBe(0);
    });
    const deletedContact = await contactRow(deletedContactId);
    expect(deletedContact.opt_out_state).toBe('none');
  });

  it('record_opt_out_writes_the_mirror_through_the_injected_port_in_the_same_transaction', async () => {
    // P20 Unit U8, step 8: proves the INJECTED port itself (recordOptOut/
    // restoreOptOut calling deps.mirror internally), as opposed to the U7
    // case above which calls syncOptOutMirror separately at the call site.
    const clientId = await seedProbeClient(pool, 'suite-mirror-port');
    probeClientIds.push(clientId);
    const phoneHash = randomBytes(32);
    const contactId = await seedContact(pool, clientId, { phoneHash, optOutState: 'none' });

    const tenantDb = createTenantDb(pool);

    // recordOptOut + the injected real syncOptOutMirror, then THROW -> no
    // opt_outs row and the contact stays 'none'.
    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        await recordOptOut(
          tx,
          {
            clientId,
            scope: 'client',
            scopeKey: clientId,
            phoneHash,
            phoneEnc: Buffer.from('enc'),
            source: 'manual',
          },
          { mirror: syncOptOutMirror },
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const optOutsAfterThrow = await pool.query('SELECT 1 FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutsAfterThrow.rowCount).toBe(0);
    const afterThrow = await contactRow(contactId);
    expect(afterThrow.opt_out_state).toBe('none');
    expect(afterThrow.opted_out_at).toBeNull();

    // Repeat without the throw: both the opt_outs row and the mirror land,
    // in the SAME transaction, via the injected port alone.
    await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('enc'),
          source: 'manual',
        },
        { mirror: syncOptOutMirror },
      );
    });

    const optOutRow = await pool.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    expect(optOutRow.rows).toHaveLength(1);
    const optOutId = optOutRow.rows[0]!.id;
    const createdAt = optOutRow.rows[0]!.created_at;

    const afterRecord = await contactRow(contactId);
    expect(afterRecord.opt_out_state).toBe('opted_out');
    expect(afterRecord.opted_out_at?.toISOString()).toBe(createdAt.toISOString());

    // restoreOptOut + the injected real syncOptOutMirror -> contact back to
    // 'none', still via the injected port alone.
    await tenantDb.withTenant(clientId, async (tx) => {
      await restoreOptOut(
        tx,
        {
          clientId,
          optOutId,
          actor: { type: 'user', userId: randomUUID() },
          restoreReason: 'test',
        },
        { mirror: syncOptOutMirror },
      );
    });

    const afterRestore = await contactRow(contactId);
    expect(afterRestore.opt_out_state).toBe('none');
    expect(afterRestore.opted_out_at).toBeNull();
  });
});
