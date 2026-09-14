import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createPool, TenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { expect } from 'vitest';
import { hashRecipient } from '../../../platform/crypto/phone-hash.js';
import { runSnapshotToCompletion } from '../snapshot.worker.js';

/**
 * broadcasts-test-support.ts (P23 Unit U4) - shared, non-test fixture
 * machinery for `snapshot.integration.test.ts` / `expansion.integration.
 * test.ts`. Lives under `__tests__/` so the tenant-scope guard's seed/
 * cleanup exemption covers its raw INSERTs (same convention as `modules/
 * contacts/__tests__/import-test-support.ts`), and vitest's `include` glob
 * never picks it up as its own suite (no `.test.ts` suffix).
 */

export type TestPool = ReturnType<typeof createPool>;

/** One `FileKeyProvider` mounted for `'optout-pepper'` only - same shape as `contacts/__tests__/import-test-support.ts#buildTestKeyProvider`. */
export function buildBroadcastsKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-broadcasts-test-ring-'));
  const ringPath = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0f).toString('base64');
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
  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper'] });
}

export interface SeededBroadcastTenant {
  clientId: string;
  instanceId: string;
  tagId: string;
}

/** Seeds a client + plan (with `max_broadcast_recipients` override) + whatsapp_instance + one contact_tags row. */
export async function seedBroadcastTenant(
  pool: TestPool,
  probeClientIds: string[],
  options: { maxBroadcastRecipients?: number } = {},
): Promise<SeededBroadcastTenant> {
  const clientId = randomUUID();
  const instanceId = randomUUID();
  const planId = randomUUID();
  const tagId = randomUUID();
  const suffix = clientId.slice(0, 8);

  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
    [clientId, `broadcast probe client ${suffix}`, `broadcast-probe-${suffix}`],
  );
  await pool.query(`INSERT INTO plans (id, name) VALUES ($1, $2)`, [
    planId,
    `broadcast probe plan ${suffix}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances, max_broadcast_recipients)
     VALUES ($1, 5, 5, $2)`,
    [planId, options.maxBroadcastRecipients ?? 20_000],
  );
  await pool.query(`UPDATE clients SET plan_id = $1 WHERE id = $2 -- client_id = id = $2`, [
    planId,
    clientId,
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'broadcast-probe', 'connected', 0)`,
    [instanceId, clientId],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence)
     VALUES ($1, $2, 1)`,
    [instanceId, clientId],
  );
  await pool.query(
    `INSERT INTO contact_tags (id, client_id, name) VALUES ($1, $2, 'broadcast-tag')`,
    [tagId, clientId],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId, tagId };
}

export interface SeedContactOptions {
  firstName?: string | null;
  attrs?: Record<string, unknown>;
  tagged?: boolean;
}

/** Seeds one contact (tagged with the tenant's `tagId` by default) and returns its id + phone_hash. */
export async function seedBroadcastContact(
  pool: TestPool,
  keyProvider: KeyProvider,
  tenant: SeededBroadcastTenant,
  seq: number,
  options: SeedContactOptions = {},
): Promise<{ contactId: string; phoneHash: Buffer; e164: string }> {
  const contactId = randomUUID();
  const digits = String(5_000_000 + seq).padStart(10, '0');
  const e164 = `+1${digits}`;
  const waJid = `1${digits}@s.whatsapp.net`;
  const phoneHash = hashRecipient(keyProvider, e164);

  await pool.query(
    `INSERT INTO contacts
       (id, client_id, phone_e164, phone_hash, wa_jid, first_name, attrs, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')`,
    [
      contactId,
      tenant.clientId,
      e164,
      phoneHash,
      waJid,
      options.firstName === undefined ? 'Test' : options.firstName,
      JSON.stringify(options.attrs ?? {}),
    ],
  );

  if (options.tagged !== false) {
    await pool.query(
      `INSERT INTO contact_tag_links (client_id, tag_id, contact_id) VALUES ($1, $2, $3)`,
      [tenant.clientId, tenant.tagId, contactId],
    );
  }

  return { contactId, phoneHash, e164 };
}

/** Inserts one `campaigns` row with the given audience/message JSON, returns its id. */
export async function seedBroadcastCampaign(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  options: {
    status: string;
    body: string;
    priority?: 'high' | 'normal' | 'low';
  },
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      campaignId,
      tenant.clientId,
      tenant.instanceId,
      options.status,
      `broadcast probe campaign ${campaignId}`,
      JSON.stringify({ kind: 'contacts', tagIds: [tenant.tagId], contactIds: [] }),
      JSON.stringify({ kind: 'text', body: options.body }),
      options.priority ?? 'low',
    ],
  );
  return campaignId;
}

/** FK-safe cleanup for every row this file's helpers seed, plus message_jobs/refs/delivery events from expansion. */
export async function cleanupBroadcastProbeClients(
  pool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM delivery_event_ids WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_wa_ids WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_charge_guards WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM pacing_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_daily_usage WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaign_counters WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contact_tag_links WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contact_tags WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
  // Scoped to THIS test's probe clients only (main-session C1 fix, 2026-09-06):
  // the previous `LIKE 'broadcast probe plan %'` form nulled `plan_id` on every
  // concurrently-running broadcast test's client (vitest runs files in parallel
  // workers) and produced a flaky `BroadcastLimitError: no plan` mid-test. Each
  // probe plan's name embeds its own client id prefix (see seedBroadcastTenant).
  const probePlanNames = probeClientIds.map((id) => `broadcast probe plan ${id.slice(0, 8)}`);
  await pool.query('UPDATE clients SET plan_id = NULL WHERE id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
  await pool.query(
    'DELETE FROM plan_limits WHERE plan_id IN (SELECT id FROM plans WHERE name = ANY($1))',
    [probePlanNames],
  );
  await pool.query('DELETE FROM plans WHERE name = ANY($1)', [probePlanNames]);
}

/** Seeds a tenant + campaign already snapshotted with `count` recipients, in status `expanding` - shared by `expansion.integration.test.ts` and `expansion-drain-demo.integration.test.ts` (max-lines split). */
export async function seedExpandingCampaign(
  pool: TestPool,
  tenantDb: TenantDb,
  keyProvider: KeyProvider,
  probeClientIds: string[],
  count: number,
  body = 'Hello!',
): Promise<{ tenant: SeededBroadcastTenant; campaignId: string }> {
  const tenant = await seedBroadcastTenant(pool, probeClientIds);
  const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'snapshotting', body });
  await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
    campaignId,
    tenant.clientId,
  ]);
  for (let i = 0; i < count; i += 1) {
    await seedBroadcastContact(pool, keyProvider, tenant, i);
  }
  const snap = await runSnapshotToCompletion(
    { tenantDb, batchSize: 1_000 },
    { campaignId, clientId: tenant.clientId },
  );
  expect(snap).toEqual({ kind: 'done', audienceCount: count });
  return { tenant, campaignId };
}

/** Counts this client's expanded `message_jobs`/`message_job_refs` rows - shared by the same two files. */
export async function statementsFor(
  pool: TestPool,
  clientId: string,
): Promise<{ inserted: number; refs: number }> {
  const jobs = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND campaign_id IS NOT NULL`,
    [clientId],
  );
  const refs = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_job_refs WHERE client_id = $1`,
    [clientId],
  );
  return { inserted: Number(jobs.rows[0]?.count ?? 0), refs: Number(refs.rows[0]?.count ?? 0) };
}

/** Seeds a tenant + one `snapshotting` campaign + its `campaign_counters` row - shared by `snapshot.integration.test.ts` and `snapshot-missing-var.integration.test.ts` (max-lines split). */
export async function seedSnapshottingCampaign(
  pool: TestPool,
  probeClientIds: string[],
  body: string,
  status = 'snapshotting',
): Promise<{ tenant: SeededBroadcastTenant; campaignId: string }> {
  const tenant = await seedBroadcastTenant(pool, probeClientIds);
  const campaignId = await seedBroadcastCampaign(pool, tenant, { status, body });
  await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
    campaignId,
    tenant.clientId,
  ]);
  return { tenant, campaignId };
}
