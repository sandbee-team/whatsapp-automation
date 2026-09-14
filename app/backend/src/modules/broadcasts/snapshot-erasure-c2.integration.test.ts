import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { eraseContact } from '../contacts/erasure.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import { createExpansionBudget } from './expansion-budget.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastContact,
  seedSnapshottingCampaign,
  statementsFor,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';

/**
 * snapshot-erasure-c2.integration.test.ts (P23 C2 close-step hardening
 * pass) - gap (c): a contact soft-deleted (`eraseContact`, P20) AFTER its
 * campaign_recipients row was already frozen at snapshot time. The frozen
 * row is never joined back to `contacts` by the expansion path (`expansion.
 * repo.ts#readExpansionBatch` reads only `campaign_recipients`) - erasure
 * must have ZERO effect on an already-snapshotted recipient: the same job
 * is still created, from the frozen `vars`/`recipient_jid`/`recipient_hash`,
 * and nothing crashes or leaks the (now-scrubbed) live contact row's
 * absence of PII into a NEW value (the frozen snapshot already carried its
 * own copy, independent of `contacts` from the moment it was written).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];
const unlimitedBudget = () =>
  createExpansionBudget({
    ratePerSecond: 1_000_000,
    burst: 1_000_000,
    clock: { now: () => Date.now() },
  });

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-snapshot-erasure-c2-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('broadcast snapshot + later contact erasure (P23 C2, gap c)', () => {
  it('a_contact_erased_after_snapshot_still_expands_from_the_frozen_recipient_row', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(
      pool,
      probeClientIds,
      'Hi {{first_name}}!',
    );
    const { contactId, phoneHash, e164 } = await seedBroadcastContact(
      pool,
      keyProvider,
      tenant,
      0,
      { firstName: 'Priya' },
    );

    const snap = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snap).toEqual({ kind: 'done', audienceCount: 1 });

    const recipientBefore = await pool.query<{
      id: string;
      recipient_jid: string;
      recipient_e164: string;
      recipient_hash: Buffer;
      vars: { first_name: string };
      status: string;
    }>(
      `SELECT id, recipient_jid, recipient_e164, recipient_hash, vars, status
         FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientBefore.rows).toHaveLength(1);
    expect(recipientBefore.rows[0]?.vars.first_name).toBe('Priya');
    expect(recipientBefore.rows[0]?.recipient_e164).toBe(e164);
    expect(recipientBefore.rows[0]?.recipient_hash.equals(phoneHash)).toBe(true);

    // Erase the contact NOW - strictly after the snapshot froze its row.
    await tenantDb.withTenant(tenant.clientId, (tx) =>
      eraseContact(tx, {
        clientId: tenant.clientId,
        contactId,
        actor: { userId: randomUUID() },
      }),
    );
    const contactAfterErase = await pool.query<{
      deleted_at: Date | null;
      first_name: string | null;
      phone_hash: Buffer;
    }>(`SELECT deleted_at, first_name, phone_hash FROM contacts WHERE id = $1`, [contactId]);
    expect(contactAfterErase.rows[0]?.deleted_at).not.toBeNull();
    expect(contactAfterErase.rows[0]?.first_name).toBeNull();
    // phone_hash survives erasure (erase-contact.sql's own contract - it is
    // the join key to opt_outs, never scrubbed) - the frozen recipient row's
    // OWN copy is independent of this either way.
    expect(contactAfterErase.rows[0]?.phone_hash.equals(phoneHash)).toBe(true);

    // The frozen campaign_recipients row is completely unaffected by the
    // erasure - it is a snapshot, not a live join.
    const recipientAfterErase = await pool.query<{
      vars: { first_name: string };
      recipient_e164: string;
      status: string;
    }>(`SELECT vars, recipient_e164, status FROM campaign_recipients WHERE campaign_id = $1`, [
      campaignId,
    ]);
    expect(recipientAfterErase.rows[0]?.vars.first_name).toBe('Priya');
    expect(recipientAfterErase.rows[0]?.recipient_e164).toBe(e164);
    expect(recipientAfterErase.rows[0]?.status).toBe('pending');

    // Expansion still creates exactly one job, from the frozen row - never
    // crashes, never re-reads contacts, never produces a second/duplicate
    // recipient row, and the rendered body still carries the frozen name
    // (never a blank - the erasure never touches campaign_recipients.vars).
    const result = await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done' });

    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(1);
    expect(counts.refs).toBe(1);

    const jobRow = await pool.query<{ payload: { text: string }; recipient_jid: string }>(
      `SELECT payload, recipient_jid FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(jobRow.rows).toHaveLength(1);
    expect(jobRow.rows[0]?.payload.text).toBe('Hi Priya!');
    expect(jobRow.rows[0]?.recipient_jid).toBe(recipientBefore.rows[0]?.recipient_jid);

    const recipientFinal = await pool.query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientFinal.rows[0]?.status).toBe('queued');
  });
});
